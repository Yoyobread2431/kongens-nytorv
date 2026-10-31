-- 002: phone rebuys. Paste once into the Supabase SQL Editor, after schema.sql. Safe to run more than once.
-- The host's app is the only writer of games.state (it saves the whole game), so a friend's rebuy can't be
-- written into the game directly. It waits here as a request; the host's app claims it and adds the buy itself.

-- ---------- phone rebuys: table ----------

create table if not exists public.rebuy_requests (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,  -- deleting a game deletes its requests
  player_name text not null,          -- players.name of the friend who asked
  amount numeric(12,2) not null check (amount > 0 and amount <= 100000),
  user_id uuid default auth.uid(),    -- the signed-in account that asked
  status text not null default 'pending' check (status in ('pending', 'applied', 'declined')),
  created_at timestamptz default now(),
  handled_at timestamptz              -- when the host applied or declined it
);
-- The host's app keeps asking for "the pending requests of this game".
create index if not exists rebuy_requests_game_status_idx on public.rebuy_requests (game_id, status);

-- ---------- phone rebuys: who may do what ----------

alter table public.rebuy_requests enable row level security;

-- Start from nothing. Signed-out visitors keep nothing at all. Signed-in users get read, change and delete,
-- which the policies below narrow down. Nobody gets insert: the only way in is request_rebuy(), which checks the player.
revoke all on public.rebuy_requests from anon, authenticated;
grant select, update, delete on public.rebuy_requests to authenticated;

drop policy if exists "members read rebuy requests" on public.rebuy_requests;
-- Anyone in the group (a host, or a friend who has claimed a player) can see the requests.
create policy "members read rebuy requests" on public.rebuy_requests
  for select to authenticated using ((select public.is_member()));

drop policy if exists "hosts handle rebuy requests" on public.rebuy_requests;
-- Only hosts can mark a request applied or declined.
create policy "hosts handle rebuy requests" on public.rebuy_requests
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists "hosts remove rebuy requests" on public.rebuy_requests;
-- Only hosts can delete requests.
create policy "hosts remove rebuy requests" on public.rebuy_requests
  for delete to authenticated using ((select public.is_admin()));

-- No insert policy on purpose: with RLS on, a direct insert is refused even if someone grants insert later.

-- ---------- RPC: request_rebuy ----------

-- A friend asks for a rebuy of `amount` in the live game. Error codes the app maps to messages:
-- KN401 not signed in, KN403 no claimed player, KN400 amount not 0.01 to 100000, KN404 no live game,
-- KN410 not in the live game, KN409 already cashed out, KN429 a pending request from under 5 seconds ago.
create or replace function public.request_rebuy(amount numeric)
returns public.rebuy_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  amt numeric := round(request_rebuy.amount, 2);  -- qualified: the parameter has the same name as the column
  me public.players;
  g public.games;
  playing boolean;
  req public.rebuy_requests;
begin
  -- 1. Must be signed in.
  if uid is null then
    raise exception 'Sign in first' using errcode = 'KN401';
  end if;

  -- 2. Must have claimed a player. "for update" holds that player until this call ends, so two taps
  --    at the same moment run one after the other, and the second one is caught by step 7.
  select * into me from public.players p where p.user_id = uid for update;
  if not found then
    raise exception 'Pick your player first' using errcode = 'KN403';
  end if;

  -- 3. The amount, rounded to 2 decimals, must be 0.01 to 100000 (null and NaN fail too).
  if amt is null or not (amt between 0.01 and 100000) then
    raise exception 'Amount must be between 0.01 and 100000' using errcode = 'KN400';
  end if;

  -- 4. There must be a live game. If there are several, the newest one counts.
  select * into g from public.games where status = 'live' order by created_at desc limit 1;
  if not found then
    raise exception 'No game is running' using errcode = 'KN404';
  end if;

  -- 5. The player must be in that game (name compared trimmed and case-insensitively).
  --    "playing" is null when the name isn't there, false when they have cashed out ("count" is set).
  select bool_or(coalesce(jsonb_typeof(x -> 'count'), 'null') = 'null') into playing
  from jsonb_array_elements(
         case when jsonb_typeof(g.state -> 'players') = 'array' then g.state -> 'players' else '[]'::jsonb end
       ) as t(x)
  where lower(btrim(x ->> 'name')) = lower(me.name);
  if playing is null then
    raise exception '% is not in this game', me.name using errcode = 'KN410';
  end if;

  -- 6. A player who has cashed out can't rebuy.
  if not playing then
    raise exception '% has already cashed out', me.name using errcode = 'KN409';
  end if;

  -- 7. Against double taps: refuse while this player has a pending request from less than 5 seconds ago.
  if exists (select 1 from public.rebuy_requests r
             where r.game_id = g.id and r.player_name = me.name and r.status = 'pending'
               and r.created_at > now() - interval '5 seconds') then
    raise exception 'You just asked for a rebuy' using errcode = 'KN429';
  end if;

  -- 8. Leave the request for the host's app and hand it back.
  insert into public.rebuy_requests (game_id, player_name, amount, user_id)
  values (g.id, me.name, amt, uid)
  returning * into req;
  return req;
end
$$;

-- Signed-in users only (Postgres lets everyone run new functions, and Supabase also grants anon).
revoke execute on function public.request_rebuy(numeric) from public, anon;
grant execute on function public.request_rebuy(numeric) to authenticated;

-- ---------- phone rebuys: realtime ----------

-- The host's app hears about new and handled requests as they happen.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rebuy_requests') then
    alter publication supabase_realtime add table public.rebuy_requests;
  end if;
end
$$;
