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
function fakeSupabase({ admin = true, live = [], done = [] } = {}) {
  const f = { admin, live, done, rpc: {}, writes: [], rpcs: [], otp: [], onChange: null, session: { user: { id: 'u1', email: 'host@x.dk' } } };
  const answer = (q) => {
    if (q.upsert || q.delete) return new Promise((resolve) => f.writes.push({ ...q, resolve }));
    if (q.in) return Promise.resolve({ data: f.live, error: null });
    if (q.eq && q.eq[0] === 'status') return Promise.resolve({ data: f.done, error: null });
    return Promise.resolve({ data: null, error: null });
  };
  f.client = {
    auth: {
      getSession: async () => ({ data: { session: f.session }, error: null }),
      signInWithOtp: async (args) => { f.otp.push(args); return { data: {}, error: null }; },
      signOut: async () => ({ error: null }),
    },
    rpc: async (name, args) => {
      f.rpcs.push([name, args]);
      if (f.rpc[name]) return f.rpc[name](args);
      return { data: name === 'is_admin' ? f.admin : null, error: null };
    },
    from: (table) => {
      const q = { table };
      const b = { then: (res, rej) => answer(q).then(res, rej) };
      for (const m of ['select', 'eq', 'in', 'order', 'limit', 'single', 'maybeSingle', 'upsert', 'delete']) {
        b[m] = (...args) => { q[m] = args; return b; };
      }
      return b;
    },
    channel: () => ({
      on(type, filter, cb) { f.onChange = cb; return this; },
      subscribe() { return this; },
    }),
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
