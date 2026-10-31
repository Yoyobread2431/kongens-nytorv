-- Kongens Nytorv Home Games: online database. Safe to run more than once.
-- Apply ONLY to the new personal Supabase project (never to capito-portal).
-- After the first run, add the host(s):  insert into public.admins (email) values ('host@example.com') on conflict do nothing;

-- ---------- invite codes ----------

-- 8 characters without look-alikes (no I, L, O, 0, 1), taken from the random bytes of a v4 uuid.
create or replace function public.new_invite_code()
returns text
language sql
volatile
set search_path = public, pg_temp
as $$
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', get_byte(r.b, i) % 31 + 1, 1), '' order by i)
  from (select uuid_send(gen_random_uuid()) as b) r,
       unnest(array[0, 1, 2, 3, 4, 5, 10, 11]) as i;  -- bytes 6 and 8 hold the uuid version bits
$$;

-- ---------- tables ----------

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 30 and name = btrim(name)),
  user_id uuid unique references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
-- Names are the identity in game results, so "Anna" and "anna" are the same player.
create unique index if not exists players_lower_name_key on public.players (lower(name));

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'setup' check (status in ('setup', 'live', 'done')),
  state jsonb not null,             -- the app's whole game state (SPEC.md "Game state")
  result jsonb,                     -- the GameRecord once done
  invite_code text not null unique default public.new_invite_code(),
  host uuid default auth.uid(),
  rev integer not null default 1,   -- 1 on insert, +1 on every update; clients use it to skip stale realtime echoes
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists games_status_created_idx on public.games (status, created_at desc);

create table if not exists public.admins (
  email text primary key            -- hosts, matched case-insensitively against the signed-in email
);

-- ---------- games trigger: updated_at, rev, finished games stay finished ----------

create or replace function public.games_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.rev := 1;
  else
    if old.status = 'done' and new.status <> 'done' then
      raise exception 'This game is finished and cannot be reopened' using errcode = 'KN423';
    end if;
    new.rev := old.rev + 1;
  end if;
  return new;
end
$$;

drop trigger if exists games_touch on public.games;
create trigger games_touch
  before insert or update on public.games
  for each row execute function public.games_touch();

-- ---------- helpers ----------

-- True when the signed-in email is listed in admins. Security definer so it can read admins past its RLS.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.admins a
    where lower(a.email) = lower(auth.jwt() ->> 'email')
  );
$$;

-- True for hosts and for anyone who has claimed a player.
create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_admin()
      or exists (select 1 from public.players p where p.user_id = auth.uid());
$$;

-- ---------- row level security ----------

alter table public.players enable row level security;
alter table public.games enable row level security;
alter table public.admins enable row level security;

-- Signed-out visitors get nothing at all (RLS would return no rows anyway; this makes it an error).
revoke all on public.players, public.games, public.admins from anon;
-- Signed-in users may use the tables; the rules below decide what each person may actually do.
grant select, insert, update, delete on public.players, public.games to authenticated;
grant select on public.admins to authenticated;

-- players
drop policy if exists "members read players" on public.players;
-- Anyone in the group (a host, or a friend who has claimed a player) can see every player.
create policy "members read players" on public.players
  for select to authenticated using ((select public.is_member()));

drop policy if exists "hosts add players" on public.players;
-- Only hosts can add players directly. Friends add themselves through claim_player().
create policy "hosts add players" on public.players
  for insert to authenticated with check ((select public.is_admin()));

drop policy if exists "hosts change players" on public.players;
-- Only hosts can rename players or change who a player belongs to.
create policy "hosts change players" on public.players
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists "hosts remove players" on public.players;
-- Only hosts can delete players.
create policy "hosts remove players" on public.players
  for delete to authenticated using ((select public.is_admin()));

-- games
drop policy if exists "members read games" on public.games;
-- Anyone in the group can see every game: the live one, and every finished one with its results.
create policy "members read games" on public.games
  for select to authenticated using ((select public.is_member()));

drop policy if exists "hosts add games" on public.games;
-- Only hosts can start games.
create policy "hosts add games" on public.games
  for insert to authenticated with check ((select public.is_admin()));

drop policy if exists "hosts change games" on public.games;
-- Only hosts can change a game: buy-ins, rebuys, cash outs, finishing it.
create policy "hosts change games" on public.games
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists "hosts remove games" on public.games;
-- Only hosts can delete games.
create policy "hosts remove games" on public.games
  for delete to authenticated using ((select public.is_admin()));

-- admins
drop policy if exists "hosts read hosts" on public.admins;
-- Only hosts can see the host list. Nobody can change it through the app: edit it in the SQL editor.
create policy "hosts read hosts" on public.admins
  for select to authenticated using ((select public.is_admin()));

-- ---------- RPC: claim_player ----------

-- A signed-in friend with a valid invite code becomes a player: their existing one, an unclaimed
-- one with that name, or a new one. Error codes the app maps to messages:
-- KN401 not signed in, KN404 bad invite code, KN400 bad name, KN409 name taken by someone else.
create or replace function public.claim_player(code text, player_name text)
returns public.players
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  clean text := btrim(coalesce(player_name, ''));
  me public.players;
begin
  if uid is null then
    raise exception 'Sign in first' using errcode = 'KN401';
  end if;
  if not exists (select 1 from public.games g where g.invite_code = upper(btrim(coalesce(code, '')))) then
    raise exception 'That invite code is not valid' using errcode = 'KN404';
  end if;
  if char_length(clean) not between 1 and 30 then
    raise exception 'Names are 1 to 30 characters' using errcode = 'KN400';
  end if;

  select * into me from public.players p where p.user_id = uid;
  if found then
    return me;
  end if;

  -- "where user_id is null" makes two people claiming the same name at once safe: only one update wins.
  update public.players p set user_id = uid
   where lower(p.name) = lower(clean) and p.user_id is null
  returning * into me;
  if found then
    return me;
  end if;

  if exists (select 1 from public.players p where lower(p.name) = lower(clean)) then
    raise exception 'Someone else already claimed %', clean using errcode = 'KN409';
  end if;

  insert into public.players (name, user_id) values (clean, uid) returning * into me;
  return me;
exception
  when unique_violation then  -- someone created the same name a moment ago
    raise exception 'Someone else already claimed %', clean using errcode = 'KN409';
end
$$;

-- ---------- RPC: game_by_code ----------

-- For the join page: the game's name, status and players, and which players are already claimed.
-- Returns null for a wrong code. Shows nothing else (no amounts), so non-members can call it.
create or replace function public.game_by_code(code text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'name', g.state ->> 'name',
    'status', g.status,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', btrim(x ->> 'name'),
               'claimed', exists (select 1 from public.players p
                                  where lower(p.name) = lower(btrim(x ->> 'name')) and p.user_id is not null))
             order by o)
      from jsonb_array_elements(
             case when jsonb_typeof(g.state -> 'players') = 'array' then g.state -> 'players' else '[]'::jsonb end
           ) with ordinality as t(x, o)
      where coalesce(btrim(x ->> 'name'), '') <> ''
    ), '[]'::jsonb)
  )
  from public.games g
  where g.invite_code = upper(btrim(coalesce(code, '')))
    and auth.uid() is not null;
$$;

-- ---------- function permissions ----------
-- Postgres lets everyone run new functions, and Supabase also grants anon. Signed-in users only.

revoke execute on function
  public.new_invite_code(), public.is_admin(), public.is_member(),
  public.claim_player(text, text), public.game_by_code(text)
  from public, anon;
grant execute on function
  public.new_invite_code(), public.is_admin(), public.is_member(),
  public.claim_player(text, text), public.game_by_code(text)
  to authenticated;

-- ---------- realtime ----------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'games') then
    alter publication supabase_realtime add table public.games;
  end if;
end
$$;
