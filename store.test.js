// Run: node --test store.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const createStore = require('./store.js');

const GAME_KEY = 'pokerNight.game.v2';
const HIST_KEY = 'pokerNight.history.v2';
const MSG_LOCAL = 'Saved on this device only';
const MSG_UNREACHABLE = "Can't reach saved games right now. Showing this device's copy.";
const MSG_SAVE_FAIL = "Couldn't save. Check your connection.";

const game = (name, phase = 'playing') => ({
  phase, buyIn: 20, chips: 2000, players: [{ name, buys: [{ money: 20, chips: 2000 }], count: null }],
  elapsed: 0, since: null, startedAt: null, result: null,
});
const rec = (endedAt) => ({ endedAt, startedAt: null, duration: 0, pot: 40, results: [], transfers: [] });
const withId = (r, id = String(r.endedAt)) => ({ ...r, id }); // records saved without an id get String(endedAt)

// Settles pending promise chains (setImmediate is not mocked).
const flush = () => new Promise((r) => setImmediate(r));

function deepFreeze(o) {
  Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v));
  return Object.freeze(o);
}

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    map: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}
const throwingStorage = () => ({
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
});

// Controllable db: writes stay pending until the test resolves or rejects them.
function fakeDb() {
  const db = {
    sets: [], adds: [], docOps: [], gameSubs: 0, histSubs: 0, order: null, gameNext: null, histNext: null,
    doc(path) {
      assert.equal(path, 'games/current');
      return {
        set: (data) => new Promise((resolve, reject) => db.sets.push({ data, resolve, reject })),
        onSnapshot(next, error) { db.gameSubs++; db.gameNext = next; db.gameError = error; return () => {}; },
      };
    },
    collection(path) {
      assert.equal(path, 'history');
      return {
        add: (data) => new Promise((resolve, reject) => db.adds.push({ data, resolve, reject })),
        doc: (id) => ({
          set: (data) => new Promise((resolve, reject) => db.docOps.push({ op: 'set', id, data, resolve, reject })),
          delete: () => new Promise((resolve, reject) => db.docOps.push({ op: 'delete', id, resolve, reject })),
        }),
        orderBy(field, dir) {
          db.order = [field, dir];
          return { onSnapshot(next, error) { db.histSubs++; db.histNext = next; db.histError = error; return () => {}; } };
        },
      };
    },
  };
  return db;
}
const docSnap = (data, meta = {}) => ({
  id: 'current', exists: data !== undefined, data: () => (data === undefined ? undefined : deepFreeze(data)),
  metadata: { fromCache: false, hasPendingWrites: false, ...meta },
});
const querySnap = (docs, meta = {}) => ({
  docs: docs.map(([id, data]) => ({ id, exists: true, data: () => deepFreeze(data), metadata: {} })),
  metadata: { fromCache: false, hasPendingWrites: false, ...meta },
});

// Builds a store on a fake window. db: undefined = no window.claude, null = use("db") resolves null.
function setup(t, { storage = fakeStorage(), db, claude, crypto } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = [];
  const uses = [];
  const win = { localStorage: storage, addEventListener: (type, fn) => type === 'storage' && listeners.push(fn) };
  if (crypto) win.crypto = crypto;
  if (claude) win.claude = claude;
  else if (db !== undefined) win.claude = { use: async (name) => { uses.push(name); return db; } };
  const calls = { game: [], history: [], status: [] };
  const store = createStore(win);
  store.init({
    onGame: (g) => calls.game.push(g),
    onHistory: (h) => calls.history.push(h),
    onStatus: (s) => calls.status.push(s),
  });
  const fireStorage = (key) => listeners.forEach((fn) => fn({ key, newValue: storage.getItem(key) }));
  return { store, calls, storage, uses, fireStorage };
}

// --- local mode ---------------------------------------------------------

test('no window.claude: local mode, sync delivery of the local copy, no status banner', (t) => {
  const g = game('Anna');
  const { store, calls } = setup(t, { storage: fakeStorage({ [GAME_KEY]: g, [HIST_KEY]: [rec(1)] }) });
  assert.deepEqual(calls.game, [g]);
  assert.deepEqual(calls.history, [[withId(rec(1))]]);
  assert.deepEqual(calls.status, []);
  assert.equal(store.mode, 'local');
});

test('empty localStorage: onGame(null) and onHistory([])', (t) => {
  const { calls } = setup(t);
  assert.deepEqual(calls.game, [null]);
  assert.deepEqual(calls.history, [[]]);
});

test('use("db") resolves null: local mode, local status, saves stay local', async (t) => {
  const { store, calls, storage, uses } = setup(t, { db: null });
  assert.deepEqual(calls.status, []); // nothing until the platform answers
  await flush();
  assert.deepEqual(uses, ['db']);
  assert.equal(store.mode, 'local');
  assert.deepEqual(calls.status, [MSG_LOCAL]);
  store.saveGame(game('Bo'));
  assert.deepEqual(JSON.parse(storage.getItem(GAME_KEY)), game('Bo'));
});

test('use("db") rejecting is treated like null', async (t) => {
  const { store, calls } = setup(t, { claude: { use: () => Promise.reject(new Error('boom')) } });
  await flush();
  assert.equal(store.mode, 'local');
  assert.deepEqual(calls.status, [MSG_LOCAL]);
});

test('localStorage that throws: no crash, null/[] delivered, addGame still works in memory', async (t) => {
  const { store, calls } = setup(t, { storage: throwingStorage() });
  assert.deepEqual(calls.game, [null]);
  assert.deepEqual(calls.history, [[]]);
  assert.doesNotThrow(() => store.saveGame(game('Anna')));
  const id = await store.addGame(rec(5));
  assert.ok(typeof id === 'string' && id.length > 0, 'a timestamp id without crypto.randomUUID');
  assert.deepEqual(calls.history.at(-1), [withId(rec(5), id)]);
});

test('localStorage getter itself throwing (sandboxed frame) is survived', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const win = { get localStorage() { throw new Error('SecurityError'); } };
  const calls = [];
  const store = createStore(win);
  store.init({ onGame: (g) => calls.push(g), onHistory: (h) => calls.push(h) });
  assert.deepEqual(calls, [null, []]);
  assert.doesNotThrow(() => store.saveGame(game('Anna')));
});

test('corrupt or wrongly shaped localStorage values are ignored', (t) => {
  const storage = fakeStorage();
  storage.setItem(GAME_KEY, '{not json');
  storage.setItem(HIST_KEY, JSON.stringify({ not: 'an array' }));
  const { calls } = setup(t, { storage });
  assert.deepEqual(calls.game, [null]);
  assert.deepEqual(calls.history, [[]]);
});

test('storage event from another window is delivered via onGame / onHistory', (t) => {
  const { calls, storage, fireStorage } = setup(t);
  storage.setItem(GAME_KEY, JSON.stringify(game('Cy')));
  fireStorage(GAME_KEY);
  assert.deepEqual(calls.game.at(-1), game('Cy'));
  storage.setItem(HIST_KEY, JSON.stringify([rec(1), rec(3)]));
  fireStorage(HIST_KEY);
  assert.deepEqual(calls.history.at(-1), [withId(rec(3)), withId(rec(1))]);
  const before = calls.game.length + calls.history.length;
  fireStorage('pokerNight.tab');
  assert.equal(calls.game.length + calls.history.length, before);
});

test('addGame in local mode prepends, saves and calls onHistory', async (t) => {
  const { store, calls, storage } = setup(t, { storage: fakeStorage({ [HIST_KEY]: [rec(1)] }) });
  const id = await store.addGame(rec(2));
  assert.deepEqual(calls.history.at(-1), [withId(rec(2), id), withId(rec(1))]);
  assert.deepEqual(JSON.parse(storage.getItem(HIST_KEY)), [withId(rec(2), id), withId(rec(1))]);
});

test('history ids: kept when stored, String(endedAt) for old records, crypto.randomUUID for new ones', async (t) => {
  const { store, calls, storage } = setup(t, {
    storage: fakeStorage({ [HIST_KEY]: [rec(1), withId(rec(2), 'kept')] }),
    crypto: { randomUUID: () => 'uuid-1' },
  });
  assert.deepEqual(calls.history[0].map((r) => r.id), ['kept', '1']);
  assert.equal(await store.addGame(withId(rec(3), 'ignored')), 'uuid-1');
  assert.deepEqual(JSON.parse(storage.getItem(HIST_KEY)).map((r) => r.id), ['uuid-1', 'kept', '1']);
});

test('updateGame and deleteGame work offline in local mode', async (t) => {
  const { store, calls, storage } = setup(t, { storage: fakeStorage({ [HIST_KEY]: [withId(rec(1), 'a'), withId(rec(2), 'b')] }) });
  const paid = { ...rec(1), transfers: [{ from: 'Bo', to: 'Anna', amount: 20, paid: true }] };
  await store.updateGame('a', withId(paid, 'other'));
  assert.deepEqual(calls.history.at(-1), [withId(rec(2), 'b'), withId(paid, 'a')]);
  await store.deleteGame('b');
  assert.deepEqual(calls.history.at(-1), [withId(paid, 'a')]);
  assert.deepEqual(JSON.parse(storage.getItem(HIST_KEY)), [withId(paid, 'a')]);
  await assert.rejects(store.updateGame('b', rec(2)), { code: 'not_found' });
  assert.equal(calls.history.length, 3, 'a refused update calls nothing');
  assert.deepEqual(calls.status, []);
});

test('db mode: ids are doc ids; updateGame sets the doc, deleteGame deletes it', async (t) => {
  const db = fakeDb();
  const { store, calls } = setup(t, { db });
  await flush();
  db.histNext(querySnap([['a', withId(rec(1), 'stale')], ['b', rec(2)]]));
  assert.deepEqual(calls.history.at(-1).map((r) => r.id), ['b', 'a']);

  let p = store.updateGame('a', withId({ ...rec(1), pot: 60 }, 'a'));
  await flush();
  assert.deepEqual(db.docOps.map(({ op, id, data }) => [op, id, data]), [['set', 'a', { ...rec(1), pot: 60 }]]);
  db.docOps[0].resolve();
  await p;
  assert.deepEqual(calls.history.at(-1)[1], withId({ ...rec(1), pot: 60 }, 'a'));

  p = store.deleteGame('b');
  await flush();
  assert.deepEqual([db.docOps[1].op, db.docOps[1].id], ['delete', 'b']);
  db.docOps[1].resolve();
  await p;
  assert.deepEqual(calls.history.at(-1).map((r) => r.id), ['a']);

  p = store.deleteGame('a');
  await flush();
  db.docOps[2].reject({ code: 'unavailable', message: 'x' });
  await assert.rejects(p, { code: 'unavailable' });
  assert.deepEqual(calls.status, [MSG_SAVE_FAIL]);
  assert.deepEqual(calls.history.at(-1).map((r) => r.id), ['a'], 'kept when the delete failed');
});

test('history comes newest first, locally and from the db', async (t) => {
  const db = fakeDb();
  const { calls } = setup(t, { db, storage: fakeStorage({ [HIST_KEY]: [rec(1), rec(3), rec(2)] }) });
  assert.deepEqual(calls.history[0].map((r) => r.endedAt), [3, 2, 1]);
  await flush();
  assert.deepEqual(db.order, ['endedAt', 'desc']);
  db.histNext(querySnap([['a', rec(10)], ['b', rec(30)], ['c', rec(20)]]));
  assert.deepEqual(calls.history.at(-1).map((r) => r.endedAt), [30, 20, 10]);
});

// --- shared db mode -----------------------------------------------------

test('db connects: shared mode, subscribes exactly once to each', async (t) => {
  const db = fakeDb();
  const { store } = setup(t, { db });
  assert.equal(store.mode, 'local');
  await flush();
  assert.equal(store.mode, 'shared');
  store.saveGame(game('A'));
  store.saveGame(game('B'));
  db.gameNext(docSnap(game('C')));
  assert.equal(db.gameSubs, 1);
  assert.equal(db.histSubs, 1);
});

test('at most one db write in flight; the latest state is coalesced', async (t) => {
  const db = fakeDb();
  const { store, storage } = setup(t, { db });
  await flush();
  store.saveGame(game('s1'));
  await flush();
  store.saveGame(game('s2'));
  store.saveGame(game('s3'));
  await flush();
  assert.equal(db.sets.length, 1);
  assert.deepEqual(db.sets[0].data, game('s1'));
  assert.deepEqual(JSON.parse(storage.getItem(GAME_KEY)), game('s3')); // localStorage written at once
  db.sets[0].resolve();
  await flush();
  assert.equal(db.sets.length, 2);
  assert.deepEqual(db.sets[1].data, game('s3'));
  db.sets[1].resolve();
  await flush();
  assert.equal(db.sets.length, 2);
});

test('the queued write still goes after a failed one', async (t) => {
  const db = fakeDb();
  const { store, calls } = setup(t, { db });
  await flush();
  store.saveGame(game('s1'));
  store.saveGame(game('s2'));
  await flush();
  db.sets[0].reject({ code: 'unavailable', message: 'x' });
  await flush();
  assert.deepEqual(calls.status, [MSG_SAVE_FAIL]);
  assert.deepEqual(db.sets[1].data, game('s2'));
  db.sets[1].resolve();
  await flush();
  assert.deepEqual(calls.status, [MSG_SAVE_FAIL, '']);
});

test('saves made while use("db") is pending are written once connected', async (t) => {
  let answer;
  const db = fakeDb();
  const { store } = setup(t, { claude: { use: () => new Promise((r) => { answer = r; }) } });
  store.saveGame(game('early'));
  answer(db);
  await flush();
  assert.equal(db.sets.length, 1);
  assert.deepEqual(db.sets[0].data, game('early'));
});

test('own echo and hasPendingWrites snapshots are ignored while writes are pending', async (t) => {
  const db = fakeDb();
  const { store, calls } = setup(t, { db });
  await flush();
  const before = calls.game.length;
  store.saveGame(game('mine'));
  await flush();
  db.gameNext(docSnap(game('mine'), { hasPendingWrites: true }));
  db.gameNext(docSnap(game('stale'))); // remote state racing our in-flight write
  store.saveGame(game('newer')); // queued behind the in-flight write
  db.sets[0].resolve();
  await flush();
  db.gameNext(docSnap(game('stale'))); // still a write in flight
  assert.equal(calls.game.length, before);
  db.sets[1].resolve();
  await flush();
  db.gameNext(docSnap(game('newer'), { hasPendingWrites: true })); // pending flag alone is enough
  assert.equal(calls.game.length, before);
});

test('a remote snapshot from another device is delivered when idle and mirrored', async (t) => {
  const db = fakeDb();
  const { calls, storage } = setup(t, { db });
  await flush();
  db.gameNext(docSnap(game('Phone')));
  assert.deepEqual(calls.game.at(-1), game('Phone'));
  assert.deepEqual(JSON.parse(storage.getItem(GAME_KEY)), game('Phone'));
});

test('a missing db doc keeps the local copy', async (t) => {
  const db = fakeDb();
  const { calls, storage } = setup(t, { db, storage: fakeStorage({ [GAME_KEY]: game('Local') }) });
  await flush();
  db.gameNext(docSnap(undefined));
  assert.deepEqual(calls.game, [game('Local')]);
  assert.deepEqual(JSON.parse(storage.getItem(GAME_KEY)), game('Local'));
});

test('an empty cached history snapshot does not wipe the local copy', async (t) => {
  const db = fakeDb();
  const { calls, storage } = setup(t, { db, storage: fakeStorage({ [HIST_KEY]: [rec(1)] }) });
  await flush();
  db.histNext(querySnap([], { fromCache: true }));
  assert.equal(calls.history.length, 1);
  assert.deepEqual(JSON.parse(storage.getItem(HIST_KEY)), [rec(1)]);
});

test('addGame in db mode adds to "history" and calls onHistory without duplicates', async (t) => {
  const db = fakeDb();
  const { store, calls, storage } = setup(t, { db });
  await flush();
  db.histNext(querySnap([['old', rec(1)]]));

  // Snapshot lands after add resolves: the store prepends it itself.
  let p = store.addGame(rec(2));
  await flush();
  assert.deepEqual(db.adds[0].data, rec(2));
  db.adds[0].resolve({ id: 'new2' });
  assert.equal(await p, 'new2', 'resolves with the doc id');
  assert.deepEqual(calls.history.at(-1), [withId(rec(2), 'new2'), withId(rec(1), 'old')]);
  assert.deepEqual(JSON.parse(storage.getItem(HIST_KEY)), [withId(rec(2), 'new2'), withId(rec(1), 'old')]);

  // Latency-compensated snapshot lands first: no duplicate.
  db.histNext(querySnap([['old', rec(1)], ['new2', rec(2)]]));
  p = store.addGame(rec(3));
  await flush();
  db.histNext(querySnap([['old', rec(1)], ['new2', rec(2)], ['new3', rec(3)]], { hasPendingWrites: true }));
  db.adds[1].resolve({ id: 'new3' });
  await p;
  assert.deepEqual(calls.history.at(-1).map((r) => r.endedAt), [3, 2, 1]);
});

test('addGame rejects on a failed add and shows the save status', async (t) => {
  const db = fakeDb();
  const { store, calls } = setup(t, { db });
  await flush();
  const before = calls.history.length;
  const p = store.addGame(rec(2));
  await flush();
  db.adds[0].reject({ code: 'quota_exceeded', message: 'full' });
  await assert.rejects(p, { code: 'quota_exceeded' });
  assert.deepEqual(calls.status, [MSG_SAVE_FAIL]);
  assert.equal(calls.history.length, before);
});

test('unreachable status after 10 s without a fromCache:false snapshot', async (t) => {
  const db = fakeDb();
  const { calls } = setup(t, { db });
  await flush();
  db.gameNext(docSnap(game('cached'), { fromCache: true })); // cache doesn't count
  t.mock.timers.tick(9999);
  assert.deepEqual(calls.status, []);
  t.mock.timers.tick(1);
  assert.deepEqual(calls.status, [MSG_UNREACHABLE]);
  db.histNext(querySnap([['a', rec(1)]])); // the store answers: note clears
  assert.deepEqual(calls.status, [MSG_UNREACHABLE, '']);
});

test('a fromCache:false snapshot within 10 s means no unreachable status', async (t) => {
  const db = fakeDb();
  const { calls } = setup(t, { db });
  await flush();
  db.gameNext(docSnap(undefined));
  t.mock.timers.tick(20000);
  assert.deepEqual(calls.status, []);
});

test('a subscription error shows the unreachable status', async (t) => {
  const db = fakeDb();
  const { calls } = setup(t, { db });
  await flush();
  db.gameError({ code: 'revoked', message: 'gone' });
  assert.deepEqual(calls.status, [MSG_UNREACHABLE]);
});

test('data handed to callbacks is cloned and not frozen', async (t) => {
  const db = fakeDb();
  const { store, calls } = setup(t, { db });
  await flush();
  db.gameNext(docSnap(game('Frozen')));
  const g = calls.game.at(-1);
  assert.equal(Object.isFrozen(g), false);
  assert.equal(Object.isFrozen(g.players[0]), false);
  g.players[0].name = 'Changed'; // must not throw in strict mode

  db.histNext(querySnap([['a', rec(1)]]));
  const h = calls.history.at(-1);
  assert.equal(Object.isFrozen(h[0]), false);
  h.length = 0; // mutating our copy must not touch the store's list
  store.addGame(rec(2));
  await flush();
  db.adds[0].resolve({ id: 'b' });
  await flush();
  assert.deepEqual(calls.history.at(-1), [withId(rec(2), 'b'), withId(rec(1), 'a')]);
});
