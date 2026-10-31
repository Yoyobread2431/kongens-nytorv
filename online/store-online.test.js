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

// Fake supabase-js client. Reads answer at once from f.live / f.done; writes wait in f.writes until the test answers them.
// rebuy_requests (and the "live game" read) behave like PostgREST: every eq filters, update changes the hits, order sorts, select picks columns.
function fakeSupabase({ admin = true, live = [], done = [], requests = [] } = {}) {
  const f = {
    admin, live, done, requests, rpc: {}, writes: [], rpcs: [], otp: [], listen: {}, removed: [],
    get onChange() { return this.listen.games; }, session: { user: { id: 'u1', email: 'host@x.dk' } },
  };
  const answer = (q) => {
    if (q.upsert || q.delete) return new Promise((resolve) => f.writes.push({ ...q, resolve }));
    if (q.table === 'rebuy_requests' || (q.eq && q.eq[1] === 'live')) {
      const hit = (q.table === 'games' ? f.live : f.requests).filter((r) => q.calls.every(([m, k, v]) => m !== 'eq' || r[k] === v));
      if (q.update) hit.forEach((r) => Object.assign(r, q.update[0]));
      if (q.order) hit.sort((a, b) => (a[q.order[0]] < b[q.order[0]] ? -1 : 1) * (q.order[1].ascending ? 1 : -1));
      const cols = q.select[0].split(', ');
      return Promise.resolve({ data: hit.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))), error: null });
    }
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
      const q = { table, calls: [] };
      const b = { then: (res, rej) => answer(q).then(res, rej) };
      for (const m of ['select', 'eq', 'in', 'order', 'limit', 'single', 'maybeSingle', 'upsert', 'delete', 'update']) {
        b[m] = (...args) => { q[m] = args; q.calls.push([m, ...args]); return b; };
      }
      return b;
    },
    channel: () => ({
      on(type, filter, cb) { f.listen[filter.table] = cb; return this; },
      subscribe() { return this; },
    }),
    removeChannel: (ch) => { f.removed.push(ch); },
  };
  return f;
}
// Answers a pending upsert the way PostgREST would.
const landed = (w, rev) => w.resolve({ data: { id: w.upsert[0].id, rev, status: w.upsert[0].status, invite_code: 'ABCD2345' }, error: null });
const update = (row) => ({ eventType: 'UPDATE', new: row });

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
    await assert.rejects(on.requestRebuy(200), { message: MSG_OFF, code: 'failed' });
    const stop = on.watchRebuyRequests(() => assert.fail('no callback when unconfigured'));
    stop();
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
    { id: 'a', result: rec(100) }, { id: 'b', result: rec(300) }, { id: 'c', result: null }, { id: 'd', result: rec(200) },
  ] });
  await settle();
  const ends = () => seen.history.at(-1).map((r) => r.endedAt);
  assert.deepEqual(ends(), [300, 200, 100]);

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
  assert.equal(f.writes[1].upsert[0].state.name, 'C', 'B was skipped');
  assert.equal(f.writes[1].upsert[0].id, first.id, 'same row');
  landed(f.writes[1], 2);
  await settle();

  f.onChange(update({ id: first.id, status: 'live', rev: 1, state: game('A') })); // late echoes
  f.onChange(update({ id: first.id, status: 'live', rev: 2, state: game('C') }));
  assert.equal(seen.games.length, shown, 'echoes never reach the app');

  f.onChange(update({ id: first.id, status: 'live', rev: 3, state: game('D') })); // another host's edit
  assert.equal(seen.games.at(-1).name, 'D');
  assert.equal(await on.inviteCode(), 'ABCD2345');
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

  const added = store.addGame(rec(500));
  await settle();
  const fin = f.writes[1].upsert[0];
  assert.equal(fin.id, id);
  assert.equal(fin.status, 'done');
  assert.deepEqual(fin.result, rec(500));
  assert.equal(fin.ended_at, new Date(500).toISOString());
  assert.equal(fin.state.name, 'A');
  landed(f.writes[1], 2);
  await added;
  assert.deepEqual(seen.history.at(-1), [rec(500)]);

  store.saveGame(game('A', 'done')); // the app saves its results screen
  await settle();
  assert.equal(f.writes[2].upsert[0].id, id);
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
  await assert.rejects(on.signInPassword('anna@x.dk', 'nope'), { message: 'Wrong email or password.', code: 'invalid_credentials' });
  f.signupAnswer = { data: {}, error: { code: 'user_already_exists', message: 'User already registered' } };
  await assert.rejects(on.signUp('bo@x.dk', 'secret2'), { code: 'user_already_exists' });
  f.signupAnswer = { data: { user: {}, session: null }, error: null }; // "Confirm email" still on
  await assert.rejects(on.signUp('cara@x.dk', 'secret3'), { code: 'confirm_required' });
  f.signupAnswer = { data: {}, error: { code: 'something_new', message: 'Odd failure' } };
  await assert.rejects(on.signUp('dan@x.dk', 'secret4'), { message: 'Odd failure' });
});

test('requestRebuy: returns the new request, maps errors to codes and plain English', async () => {
  const { f, on } = setup();
  await settle();
  const row = { id: 'r1', game_id: 'g1', player_name: 'Anna', amount: 200, status: 'pending' };
  f.rpc.request_rebuy = async () => ({ data: row, error: null });
  assert.deepEqual(await on.requestRebuy(200), row);
  assert.deepEqual(f.rpcs.at(-1), ['request_rebuy', { amount: 200 }]);

  for (const [sqlstate, code] of [
    ['KN401', 'signed_out'], ['KN403', 'not_in_group'], ['KN400', 'bad_amount'], ['KN404', 'no_live_game'],
    ['KN410', 'not_in_game'], ['KN409', 'cashed_out'], ['KN429', 'too_fast'], ['42501', 'signed_out'], ['PGRST202', 'failed'],
  ]) {
    f.rpc.request_rebuy = async () => ({ data: null, error: { code: sqlstate, message: 'raw' } });
    await assert.rejects(on.requestRebuy(200), (e) => e instanceof Error && e.code === code && e.message !== 'raw');
  }
  f.rpc.request_rebuy = async () => ({ data: null, error: { code: 'KN409', message: 'raw' } });
  await assert.rejects(on.requestRebuy(200), { message: "You've already cashed out, so you can't rebuy. Ask the host." });
  f.rpc.claim_player = async () => ({ data: null, error: { code: 'KN409', message: 'raw' } });
  await assert.rejects(on.claim('abcd2345', 'Anna'), { code: 'taken' }, 'claim keeps its own meaning of KN409');
});

test('claimRebuyRequest / declineRebuyRequest: true only for the call that changed a pending request', async () => {
  const requests = [{ id: 'r1', status: 'pending' }, { id: 'r2', status: 'pending' }];
  const { on } = setup({ requests });
  await settle();
  assert.equal(await on.claimRebuyRequest('r1'), true);
  assert.equal(requests[0].status, 'applied');
  assert.ok(!isNaN(Date.parse(requests[0].handled_at)));
  assert.equal(await on.claimRebuyRequest('r1'), false, 'a second host window gets false');
  assert.equal(await on.declineRebuyRequest('r1'), false);
  assert.equal(await on.declineRebuyRequest('r2'), true);
  assert.equal(requests[1].status, 'declined');
  assert.equal(await on.claimRebuyRequest('r2'), false);
  assert.equal(await on.claimRebuyRequest('nope'), false);
});

test('watchRebuyRequests: the live game\'s pending requests, oldest first, again after each change', async () => {
  const at = (min) => `2026-10-31T20:${String(min).padStart(2, '0')}:00Z`;
  const live = [{ id: 'g2', rev: 1, status: 'live', invite_code: 'X', state: game('Tonight') }];
  const requests = [
    { id: 'b', game_id: 'g2', player_name: 'Bo', amount: 100, status: 'pending', created_at: at(5), user_id: 'u2' },
    { id: 'a', game_id: 'g2', player_name: 'Anna', amount: 200, status: 'pending', created_at: at(1), user_id: 'u3' },
    { id: 'x', game_id: 'g2', player_name: 'Cy', amount: 50, status: 'applied', created_at: at(0) },
    { id: 'o', game_id: 'g1', player_name: 'Cy', amount: 50, status: 'pending', created_at: at(0) }, // an older game
  ];
  const { f, on } = setup({ live, requests });
  await settle();
  const seen = [];
  const stop = on.watchRebuyRequests((list) => seen.push(list));
  await settle();
  assert.deepEqual(seen, [[
    { id: 'a', player_name: 'Anna', amount: 200, created_at: at(1) },
    { id: 'b', player_name: 'Bo', amount: 100, created_at: at(5) },
  ]]);

  requests.push({ id: 'c', game_id: 'g2', player_name: 'Anna', amount: 300, status: 'pending', created_at: at(9) });
  f.listen.rebuy_requests({ eventType: 'INSERT', new: requests.at(-1) });
  await settle();
  assert.deepEqual(seen.at(-1).map((r) => r.id), ['a', 'b', 'c']);

  assert.equal(await on.claimRebuyRequest('a'), true);
  f.listen.rebuy_requests({ eventType: 'UPDATE', new: requests[1] });
  await settle();
  assert.deepEqual(seen.at(-1).map((r) => r.id), ['b', 'c']);

  stop();
  assert.equal(f.removed.length, 1);
  f.listen.rebuy_requests({ eventType: 'INSERT', new: {} }); // a late event after stop
  await settle();
  assert.equal(seen.length, 3, 'nothing after stop');

  live.length = 0; // no live game: an empty list
  on.watchRebuyRequests((list) => seen.push(list));
  await settle();
  assert.deepEqual(seen.at(-1), []);
});
