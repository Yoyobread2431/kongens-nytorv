// Run: node --test online/store-online.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const createOnline = require('./store-online.js');

const GAME_KEY = 'kn.online.game.v1';
const HIST_KEY = 'kn.online.history.v1';
const MSG_OFF = 'Online sync is not set up.';
const MSG_READ_ONLY = 'Only the host can change the game.';
const MSG_SAVE_FAIL = "Couldn't save. Check your connection.";
const MSG_CONFLICT = "The game was changed on another device. Your last change wasn't saved: check it and do it again.";

const game = (name, phase = 'live') => ({ phase, name, players: [{ name: 'Anna', buys: [{ money: 200, at: 1 }], count: null, outAt: null }] });
const rec = (endedAt) => ({ name: `g${endedAt}`, endedAt, pot: 400, results: [], transfers: [] });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

// Fake supabase-js client. Reads answer at once from f.live / f.done; games writes wait in f.writes until the test answers them.
// The players table is an in-memory table that answers at once (f.players, changes logged in f.playerOps).
function fakeSupabase({ admin = true, live = [], done = [], players = [] } = {}) {
  const f = { admin, live, done, players, playerOps: [], staleRead: null, rpc: {}, writes: [], rpcs: [], otp: [], onChange: null, session: { user: { id: 'u1', email: 'host@x.dk' } } };
  let nextId = 100;
  const playersTable = (q) => {
    const where = Object.fromEntries(q.calls.filter(([m]) => m === 'eq' || m === 'is').map(([, k, v]) => [k, v]));
    const hit = f.players.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
    if (q.insert) {
      const [{ name }] = q.insert;
      f.playerOps.push(['insert', name]);
      if (f.players.some((r) => r.name.toLowerCase() === name.toLowerCase())) return { data: null, error: { code: '23505', message: 'dup' } };
      f.players.push({ id: `p${nextId++}`, name, user_id: null });
      return { data: null, error: null };
    }
    if (q.update) {
      const [patch] = q.update;
      f.playerOps.push(['update', patch, where]);
      if (patch.user_id && hit.length && f.players.some((r) => r.user_id === patch.user_id && !hit.includes(r))) return { data: null, error: { code: '23505', message: 'dup' } };
      hit.forEach((r) => Object.assign(r, patch));
      return { data: hit[0] ? { ...hit[0] } : null, error: null };
    }
    if (q.delete) {
      f.playerOps.push(['delete', where]);
      f.players = f.players.filter((r) => !hit.includes(r));
      return { data: null, error: null };
    }
    const rows = f.staleRead || f.players;
    f.staleRead = null;
    return { data: rows.map((r) => ({ ...r })), error: null };
  };
  const answer = (q) => {
    if (q.table === 'players') return Promise.resolve(playersTable(q));
    if (q.upsert || q.delete || q.update) return new Promise((resolve) => f.writes.push({ ...q, resolve }));
    if (q.in) return Promise.resolve({ data: f.live, error: null });
    if (q.eq && q.eq[0] === 'status') return Promise.resolve({ data: f.done, error: null });
    return Promise.resolve({ data: null, error: null });
  };
  f.client = {
    auth: {
      getSession: async () => ({ data: { session: f.session }, error: null }),
      signInWithOtp: async (args) => { f.otp.push(args); return { data: {}, error: null }; },
      signInWithPassword: async (args) => { f.pw = args; return f.pwAnswer || { data: { session: {} }, error: null }; },
      signUp: async (args) => { f.signup = args; return f.signupAnswer || { data: { session: {} }, error: null }; },
      signOut: async () => ({ error: null }),
    },
    rpc: async (name, args) => {
      f.rpcs.push([name, args]);
      if (f.rpc[name]) return f.rpc[name](args);
      return { data: name === 'is_admin' ? f.admin : null, error: null };
    },
    from: (table) => {
      const q = { table, calls: [] }; // q[method] = the last call's args; q.calls = every call in order
      const b = { then: (res, rej) => answer(q).then(res, rej) };
      for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit', 'single', 'maybeSingle', 'upsert', 'insert', 'update', 'delete']) {
        b[m] = (...args) => { q[m] = args; q.calls.push([m, ...args]); return b; };
      }
      return b;
    },
    channel: () => ({
      on(type, filter, cb) { f.onChange = cb; return this; },
      subscribe(cb) { f.subscribed = cb; return this; },
    }),
  };
  return f;
}
const update = (row) => ({ eventType: 'UPDATE', new: row });
const filters = (w) => w.calls.filter(([m]) => m === 'eq').map(([, k, v]) => [k, v]);
// What a game write sent: an upsert (a new row) or an update (an existing row, only at the rev it last saw).
const sent = (w) => (w.upsert || w.update)[0];
const rowId = (w) => (w.upsert ? w.upsert[0].id : Object.fromEntries(filters(w)).id);
// Answers a pending game write the way PostgREST would.
const landed = (w, rev) => w.resolve({ data: { id: rowId(w), rev, status: sent(w).status, invite_code: 'ABCD2345' }, error: null });

function setup(opts = {}) {
  const f = fakeSupabase(opts);
  const storage = opts.storage || fakeStorage();
  const win = { KN_CONFIG: { url: 'https://x.supabase.co', anonKey: 'k' }, supabase: { createClient: () => f.client }, localStorage: storage, crypto };
  const on = createOnline(win);
  const seen = { games: [], history: [], status: [] };
  on.store.init({ onGame: (g) => seen.games.push(g), onHistory: (h) => seen.history.push(h), onStatus: (s) => seen.status.push(s) });
  return { f, on, seen, storage, store: on.store };
}

test('configured=false: no client, store stays read-only and says why', async () => {
  for (const KN_CONFIG of [undefined, { url: 'https://x.supabase.co' }]) {
    const on = createOnline({ KN_CONFIG, localStorage: fakeStorage(), crypto });
    assert.equal(on.configured, false);
    await assert.rejects(on.signIn('a@b.dk'), { message: MSG_OFF });
    await assert.rejects(on.claim('ABCD2345', 'Anna'), { message: MSG_OFF });
    assert.equal(await on.user(), null);
    const status = [];
    on.store.init({ onStatus: (s) => status.push(s) });
    await settle();
    on.store.saveGame(game('x'));
    await assert.rejects(on.store.addGame(rec(1)), { message: MSG_READ_ONLY });
    assert.deepEqual(status, [MSG_OFF, MSG_READ_ONLY]);
  }
});

test('history: every done result, newest first, kept in order through realtime changes', async () => {
  const { f, seen, storage } = setup({ done: [
    { id: 'a', result: { ...rec(100), id: 'not-the-row' } }, { id: 'b', result: rec(300) }, { id: 'c', result: null }, { id: 'd', result: rec(200) },
  ] });
  await settle();
  const ends = () => seen.history.at(-1).map((r) => r.endedAt);
  assert.deepEqual(ends(), [300, 200, 100]);
  assert.deepEqual(seen.history.at(-1).map((r) => r.id), ['b', 'd', 'a'], 'the row id, never one inside result');

  f.onChange(update({ id: 'e', status: 'done', rev: 3, result: rec(250), state: game('e', 'done') }));
  assert.deepEqual(ends(), [300, 250, 200, 100]);
  f.onChange({ eventType: 'DELETE', old: { id: 'b' } });
  assert.deepEqual(ends(), [250, 200, 100]);
  f.onChange(update({ id: 'e', status: 'done', rev: 4, state: game('e', 'done') })); // result left out of the event
  assert.deepEqual(ends(), [250, 200, 100]);
  assert.deepEqual(JSON.parse(storage.getItem(HIST_KEY)).map(([id]) => id).sort(), ['a', 'd', 'e']);
});

test('saveGame: one write in flight, coalesced to the latest state, own echoes ignored', async () => {
  const { f, seen, store, on } = setup();
  await settle();
  store.saveGame(game('A'));
  await settle();
  assert.equal(f.writes.length, 1);
  const [{ upsert: [first] }] = f.writes;
  assert.equal(first.status, 'live');
  assert.equal(first.state.name, 'A');

  store.saveGame(game('B'));
  store.saveGame(game('C'));
  await settle();
  assert.equal(f.writes.length, 1, 'still one write in flight');

  const shown = seen.games.length;
  f.onChange(update({ id: first.id, status: 'live', rev: 1, state: game('A') })); // echo while writing
  landed(f.writes[0], 1);
  await settle();
  assert.equal(f.writes.length, 2);
  assert.equal(sent(f.writes[1]).state.name, 'C', 'B was skipped');
  assert.deepEqual(filters(f.writes[1]), [['id', first.id], ['rev', 1]], 'same row, on top of the version it saw');
  landed(f.writes[1], 2);
  await settle();

  f.onChange(update({ id: first.id, status: 'live', rev: 1, state: game('A') })); // late echoes
  f.onChange(update({ id: first.id, status: 'live', rev: 2, state: game('C') }));
  assert.equal(seen.games.length, shown, 'echoes never reach the app');

  f.onChange(update({ id: first.id, status: 'live', rev: 3, state: game('D') })); // another host's edit
  assert.equal(seen.games.at(-1).name, 'D');
  assert.equal(await on.inviteCode(), 'ABCD2345');
});

test('two host devices: a save on top of an old version is refused, and the newer game is shown', async () => {
  const { f, seen, store } = setup();
  await settle();
  store.saveGame(game('A'));
  await settle();
  landed(f.writes[0], 1);
  await settle();
  const id = f.writes[0].upsert[0].id;
  // The other device saved rev 2 (a rebuy) but this device hasn't heard yet, and saves its own change on rev 1.
  store.saveGame(game('Mine'));
  await settle();
  assert.deepEqual(filters(f.writes[1]), [['id', id], ['rev', 1]]);
  f.live = [{ id, rev: 2, status: 'live', invite_code: 'ABCD2345', state: game('Theirs') }];
  f.writes[1].resolve({ data: null, error: null }); // no row at rev 1 any more
  await settle();
  assert.equal(seen.status.at(-1), MSG_CONFLICT);
  assert.equal(seen.games.at(-1).name, 'Theirs', 'the other device\'s change is kept and shown');
  store.saveGame(game('Theirs + mine')); // done again, on top of rev 2
  await settle();
  assert.deepEqual(filters(f.writes[2]), [['id', id], ['rev', 2]]);
  landed(f.writes[2], 3);
  await settle();
  assert.equal(seen.status.at(-1), '', 'the message clears once a save lands');
});

test('a failed write shows a status and the next save retries the same row', async () => {
  const { f, seen, store } = setup();
  await settle();
  store.saveGame(game('A'));
  await settle();
  f.writes[0].resolve({ data: null, error: { message: 'offline' } });
  await settle();
  assert.equal(seen.status.at(-1), MSG_SAVE_FAIL);
  store.saveGame(game('B'));
  await settle();
  assert.equal(f.writes[1].upsert[0].id, f.writes[0].upsert[0].id);
  landed(f.writes[1], 1);
  await settle();
  assert.equal(seen.status.at(-1), '');
});

test('addGame finishes the row; closing it keeps it; the next game gets a new row', async () => {
  const { f, seen, store } = setup();
  await settle();
  store.saveGame(game('A'));
  await settle();
  landed(f.writes[0], 1);
  const id = f.writes[0].upsert[0].id;

  const added = store.addGame({ ...rec(500), id: 'ignored' });
  await settle();
  const fin = f.writes[1].upsert[0];
  assert.equal(fin.id, id);
  assert.equal(fin.status, 'done');
  assert.deepEqual(fin.result, rec(500), 'no id inside the result jsonb');
  assert.equal(fin.ended_at, new Date(500).toISOString());
  assert.equal(fin.state.name, 'A');
  landed(f.writes[1], 2);
  assert.equal(await added, id, 'resolves with the row id');
  assert.deepEqual(seen.history.at(-1), [{ ...rec(500), id }]);

  store.saveGame(game('A', 'done')); // the app saves its results screen
  await settle();
  assert.equal(rowId(f.writes[2]), id);
  landed(f.writes[2], 3);
  await settle();

  store.saveGame({ phase: 'none', players: [] }); // leaving the results: nothing to delete
  await settle();
  assert.equal(f.writes.length, 3);

  store.saveGame(game('Next', 'setup'));
  await settle();
  assert.notEqual(f.writes[3].upsert[0].id, id, 'a finished game is never overwritten');
  assert.equal(f.writes[3].upsert[0].status, 'setup');
});

test('deleting a running game deletes its row, only while unfinished', async () => {
  const { f, store } = setup();
  await settle();
  store.saveGame(game('A'));
  await settle();
  landed(f.writes[0], 1);
  store.saveGame({ phase: 'none', players: [] });
  await settle();
  assert.deepEqual(f.writes[1].delete, []);
  assert.deepEqual(f.writes[1].eq, ['id', f.writes[0].upsert[0].id]);
  assert.deepEqual(f.writes[1].in, ['status', ['setup', 'live']]);
});

test('non-admins are read-only but still see the live game', async () => {
  const { f, seen, store, storage } = setup({ admin: false, live: [{ id: 'g1', rev: 4, status: 'live', invite_code: 'X', state: game('Server') }] });
  await settle();
  assert.equal(seen.games.at(-1).name, 'Server');

  store.saveGame(game('Mine'));
  await assert.rejects(store.addGame(rec(1)), { message: MSG_READ_ONLY });
  await assert.rejects(store.updateGame('g0', rec(1)), { code: 'read_only', message: MSG_READ_ONLY });
  await assert.rejects(store.deleteGame('g0'), { code: 'read_only', message: MSG_READ_ONLY });
  assert.equal(f.writes.length, 0);
  assert.equal(seen.status.at(-1), MSG_READ_ONLY);
  assert.equal(JSON.parse(storage.getItem(GAME_KEY)).state.name, 'Server', 'the cache keeps the server copy');

  f.onChange(update({ id: 'g1', status: 'live', rev: 5, state: game('Rebuy') }));
  assert.equal(seen.games.at(-1).name, 'Rebuy');
  f.onChange({ eventType: 'INSERT', new: { id: 'g2', status: 'setup', rev: 1, state: game('Next', 'setup') } });
  assert.equal(seen.games.at(-1).name, 'Next');
});

test('a game that never reached the server is pushed on the next load', async () => {
  const storage = fakeStorage({ [GAME_KEY]: { id: null, rev: 0, status: null, state: game('Offline') } });
  const { f, seen } = setup({ storage });
  await settle();
  assert.equal(seen.games[0].name, 'Offline');
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].upsert[0].state.name, 'Offline');
});

test('claim: returns the player, maps errors to codes', async () => {
  const { f, on } = setup();
  await settle();
  const player = { id: 'p1', name: 'Anna', user_id: 'u1' };
  f.rpc.claim_player = async () => ({ data: player, error: null });
  assert.deepEqual(await on.claim('abcd2345', 'Anna'), player);
  assert.deepEqual(f.rpcs.at(-1), ['claim_player', { code: 'abcd2345', player_name: 'Anna' }]);

  for (const [sqlstate, code] of [['KN409', 'taken'], ['KN404', 'bad_code'], ['KN400', 'bad_name'], ['KN401', 'signed_out'], ['XX000', 'failed']]) {
    f.rpc.claim_player = async () => ({ data: null, error: { code: sqlstate, message: 'raw' } });
    await assert.rejects(on.claim('abcd2345', 'Anna'), (e) => e.code === code && e.message !== 'raw');
  }

  f.rpc.game_by_code = async () => ({ data: null, error: null });
  assert.equal(await on.gameByCode('NOPE'), null);
});

test('signIn sends a magic link to the trimmed email', async () => {
  const { f, on } = setup();
  await on.signIn('  anna@x.dk ', 'https://example.org/app/?join=ABCD2345');
  assert.deepEqual(f.otp, [{ email: 'anna@x.dk', options: { emailRedirectTo: 'https://example.org/app/?join=ABCD2345' } }]);
});

test('password sign-in and account creation: trimmed email, plain-English errors', async () => {
  const { f, on } = setup();
  await on.signInPassword(' anna@x.dk ', 'secret1');
  assert.deepEqual(f.pw, { email: 'anna@x.dk', password: 'secret1' });
  await on.signUp('bo@x.dk', 'secret2');
  assert.deepEqual(f.signup, { email: 'bo@x.dk', password: 'secret2' });

  f.pwAnswer = { data: {}, error: { code: 'invalid_credentials', message: 'Invalid login credentials' } };
  await assert.rejects(on.signInPassword('anna@x.dk', 'nope'), { message: 'Wrong email or password. New here? Tap Create account.', code: 'invalid_credentials' });
  f.signupAnswer = { data: {}, error: { code: 'user_already_exists', message: 'User already registered' } };
  await assert.rejects(on.signUp('bo@x.dk', 'secret2'), { code: 'user_already_exists' });
  f.signupAnswer = { data: { user: {}, session: null }, error: null }; // "Confirm email" still on
  await assert.rejects(on.signUp('cara@x.dk', 'secret3'), { code: 'confirm_required' });
  f.signupAnswer = { data: {}, error: { code: 'something_new', message: 'Odd failure' } };
  await assert.rejects(on.signUp('dan@x.dk', 'secret4'), { message: 'Odd failure' });
});

test('a host on a new device (or a re-created account) can start a game before the server confirms the host', async () => {
  // The device remembers a different user id as host (or none), and is_admin is still on its way.
  const storage = fakeStorage({ 'kn.online.admin.v1': 'old-user-id' });
  const { f, seen, store } = setup({ storage, admin: true });
  let release;
  f.rpc.is_admin = () => new Promise((r) => { release = () => r({ data: true, error: null }); });
  await settle();
  store.saveGame(game('Saturday game', 'setup')); // tapped "New game" before the server answered
  release();
  await settle();
  assert.ok(!seen.status.includes(MSG_READ_ONLY), 'not refused as a non-host');
  assert.equal(f.writes.length, 1, 'the new game is written once the server says "host"');
  assert.equal(f.writes[0].upsert[0].status, 'setup');
  assert.ok(!seen.games.slice(1).some((g) => g === null), 'the app is not reset to "no game"');
});

test('a save that failed is sent again when the connection comes back', async () => {
  const { f, seen, store } = setup({ admin: true });
  await settle();
  store.saveGame(game('Night 1'));
  await settle();
  landed(f.writes[0], 1);
  await settle();
  store.saveGame(game('Night 2')); // a rebuy, say, while the Wi-Fi drops
  await settle();
  f.writes[1].resolve({ data: null, error: { message: 'network down' } });
  await settle();
  assert.ok(seen.status.includes(MSG_SAVE_FAIL));
  f.live = [{ id: f.writes[0].upsert[0].id, rev: 1, status: 'live', invite_code: 'ABCD2345', state: game('Night 1') }];
  f.subscribed('SUBSCRIBED'); // back online: realtime reconnects and the store reloads
  await settle();
  assert.equal(f.writes.length, 3, 'the failed save is sent again');
  assert.equal(sent(f.writes[2]).state.name, 'Night 2');
  assert.notEqual(seen.games.at(-1)?.name, 'Night 1', 'the older server copy does not replace the unsent edit');
});

test('a finished game stays on screen when the connection comes back (phone wakes up)', async () => {
  const row = { id: 'g1', rev: 1, status: 'live', invite_code: 'ABCD2345', state: game('Night') };
  const { f, seen } = setup({ admin: false, live: [row] });
  await settle();
  assert.equal(seen.games.at(-1).name, 'Night');
  f.onChange(update({ ...row, rev: 2, status: 'done', state: game('Night', 'done'), result: rec(5) }));
  await settle();
  assert.equal(seen.games.at(-1).phase, 'done');
  f.live = []; // nothing running on the server any more
  f.subscribed('SUBSCRIBED');
  await settle();
  assert.equal(seen.games.at(-1)?.phase, 'done', 'results stay until the host starts the next game');
});

test('hosts update and delete finished games; history follows, echoes change nothing', async () => {
  const { f, seen, store } = setup({ done: [{ id: 'a', result: rec(100) }, { id: 'b', result: rec(200) }] });
  await settle();
  const paid = { ...rec(100), transfers: [{ from: 'Bo', to: 'Anna', amount: 50, paid: true }] };

  const up = store.updateGame('a', { ...paid, id: 'ignored' });
  await settle();
  assert.deepEqual(f.writes[0].update, [{ result: paid }], 'no id inside the result jsonb');
  assert.deepEqual(filters(f.writes[0]), [['id', 'a'], ['status', 'done']]);
  f.writes[0].resolve({ data: { id: 'a', rev: 2 }, error: null });
  await up;
  assert.deepEqual(seen.history.at(-1), [{ ...rec(200), id: 'b' }, { ...paid, id: 'a' }]);

  const del = store.deleteGame('b');
  await settle();
  assert.deepEqual(f.writes[1].delete, []);
  assert.deepEqual(filters(f.writes[1]), [['id', 'b'], ['status', 'done']]);
  f.writes[1].resolve({ data: null, error: null });
  await del;
  assert.deepEqual(seen.history.at(-1), [{ ...paid, id: 'a' }]);
  const n = seen.history.length;
  f.onChange({ eventType: 'DELETE', old: { id: 'b' } }); // its realtime echo
  assert.equal(seen.history.length, n);

  const gone = store.updateGame('b', rec(200)); // deleted meanwhile: no row matches
  await settle();
  f.writes[2].resolve({ data: null, error: null });
  await assert.rejects(gone, { code: 'not_found' });
  assert.equal(seen.history.length, n);

  const failed = store.deleteGame('a');
  await settle();
  f.writes[3].resolve({ data: null, error: { message: 'offline' } });
  await assert.rejects(failed);
  assert.equal(seen.status.at(-1), MSG_SAVE_FAIL);
  assert.deepEqual(seen.history.at(-1).map((r) => r.id), ['a'], 'kept when the delete failed');
});

test('updating the finished game still on screen: its realtime echo does not reload it', async () => {
  const { f, seen, store } = setup();
  await settle();
  store.saveGame(game('A'));
  await settle();
  landed(f.writes[0], 1);
  const id = f.writes[0].upsert[0].id;
  const added = store.addGame(rec(500));
  await settle();
  landed(f.writes[1], 2);
  await added;

  const up = store.updateGame(id, { ...rec(500), pot: 450 });
  await settle();
  f.writes[2].resolve({ data: { id, rev: 3 }, error: null });
  await up;
  const shown = seen.games.length;
  f.onChange(update({ id, status: 'done', rev: 3, state: game('A', 'done'), result: { ...rec(500), pot: 450 } }));
  assert.equal(seen.games.length, shown);
  assert.equal(seen.history.at(-1)[0].pot, 450);
});

test('players: listed by name; hosts add only new names (any case) and get every row back', async () => {
  const { f, on } = setup({ players: [{ id: 'p1', name: 'Bo', user_id: null }, { id: 'p2', name: 'anna', user_id: 'u9' }] });
  await settle();
  assert.deepEqual(await on.listPlayers(), [{ id: 'p2', name: 'anna', user_id: 'u9' }, { id: 'p1', name: 'Bo', user_id: null }]);

  const rows = await on.addPlayers(['Anna', ' Cara ', '', 'bo']);
  assert.deepEqual(rows.map((r) => r.name), ['anna', 'Cara', 'Bo']);
  assert.deepEqual(f.playerOps, [['insert', 'Cara']]);

  // Another host saved "Dan" a moment ago: the insert hits the unique name, and his row still comes back.
  f.staleRead = f.players.slice();
  f.players.push({ id: 'p9', name: 'Dan', user_id: null });
  assert.deepEqual((await on.addPlayers(['dan'])).map((r) => r.id), ['p9']);
  assert.deepEqual(f.playerOps.at(-1), ['insert', 'dan']);
});

test('players: a host links their own account, unlinks it and removes players; taken and already_linked', async () => {
  const { f, on } = setup({ players: [
    { id: 'p1', name: 'Anna', user_id: null }, { id: 'p2', name: 'Bo', user_id: 'u2' }, { id: 'p3', name: 'Cara', user_id: null },
  ] });
  await settle();
  assert.deepEqual(await on.linkPlayer('p1'), { id: 'p1', name: 'Anna', user_id: 'u1' });
  assert.deepEqual(f.playerOps.at(-1), ['update', { user_id: 'u1' }, { id: 'p1', user_id: null }]);

  await assert.rejects(on.linkPlayer('p2'), (e) => e.code === 'taken' && e.message === 'That player is already linked to someone else.');
  await assert.rejects(on.linkPlayer('p3'), (e) => e.code === 'already_linked' && /already linked to another player/.test(e.message));
  assert.equal(f.players[2].user_id, null);

  await on.unlinkPlayer('p1');
  assert.deepEqual(f.playerOps.at(-1), ['update', { user_id: null }, { id: 'p1' }]);
  assert.equal((await on.linkPlayer('p3')).user_id, 'u1');

  await on.removePlayer('p2');
  assert.deepEqual(f.playerOps.at(-1), ['delete', { id: 'p2' }]);
  assert.deepEqual((await on.listPlayers()).map((p) => p.id), ['p1', 'p3']);
});

test('players: non-hosts can list them but not change them', async () => {
  const { f, on } = setup({ admin: false, players: [{ id: 'p1', name: 'Anna', user_id: null }] });
  await settle();
  assert.equal((await on.listPlayers()).length, 1);
  for (const call of [() => on.addPlayers(['Bo']), () => on.linkPlayer('p1'), () => on.unlinkPlayer('p1'), () => on.removePlayer('p1')]) {
    await assert.rejects(call(), { code: 'read_only', message: MSG_READ_ONLY });
  }
  assert.deepEqual(f.playerOps, []);
  assert.ok(f.rpcs.filter(([name]) => name === 'is_admin').length > 1, 'asks the server, since the store says "not host"');
});
