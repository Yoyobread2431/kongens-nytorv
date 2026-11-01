// PokerStore: saves the game and finished-game history.
// Always localStorage (plus the cross-window `storage` event); the claude.ai shared db when the page has one.
// Browser: defines global PokerStore. Node (tests): exports the factory, call it with a fake window.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.PokerStore = factory(root);
})(this, function (win) {
  'use strict';

  const GAME_KEY = 'pokerNight.game.v2';
  const HIST_KEY = 'pokerNight.history.v2';
  const MSG_LOCAL = 'Saved on this device only';
  const MSG_UNREACHABLE = "Can't reach saved games right now. Showing this device's copy.";
  const MSG_SAVE_FAIL = "Couldn't save. Check your connection.";
  const REACH_TIMEOUT = 10000;

  const noop = () => {};
  // Deep copy: unfreezes db snapshot data and detaches what we hand out from what we keep.
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const isGame = (g) => !!g && typeof g === 'object' && Array.isArray(g.players);
  const newestFirst = (list) => (Array.isArray(list) ? list : [])
    .filter((r) => r && typeof r === 'object')
    .map((r) => (r.id == null ? Object.assign(r, { id: String(r.endedAt) }) : r)) // saved before records had ids
    .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
  const newId = () => (win.crypto && typeof win.crypto.randomUUID === 'function'
    ? win.crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  // A record as the db keeps it: there the doc id is the record's id.
  const bare = (record) => { const r = clone(record) || {}; delete r.id; return r; };
  const gone = () => Object.assign(new Error("That game isn't saved any more."), { code: 'not_found' });

  function read(key) {
    try {
      const s = win.localStorage.getItem(key);
      return s ? JSON.parse(s) : null;
    } catch (e) {
      return null;
    }
  }
  function write(key, value) {
    try {
      win.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* storage blocked or full: keep going in memory */ }
  }
  function readGame() {
    const g = read(GAME_KEY);
    return isGame(g) ? g : null;
  }

  let cb = { onGame: noop, onHistory: noop, onStatus: noop };
  let started = false;
  let status = '';
  let history = [];           // newest first
  let historyIds = new Set(); // db doc ids in the last history snapshot
  let db = null;
  let gameRef = null;
  let connecting = false;     // window.claude.use("db") not answered yet
  let ready = Promise.resolve();
  let inFlight = false;       // a games/current write is running
  let queued = null;          // latest state waiting to be written
  let timer = null;

  const store = { mode: 'local', init, saveGame, addGame, updateGame, deleteGame };
  return store;

  function setStatus(text) {
    if (text === status) return;
    status = text;
    cb.onStatus(text);
  }

  function init(opts) {
    if (started) return;
    started = true;
    opts = opts || {};
    cb = { onGame: opts.onGame || noop, onHistory: opts.onHistory || noop, onStatus: opts.onStatus || noop };

    history = newestFirst(read(HIST_KEY));
    cb.onGame(readGame());
    cb.onHistory(clone(history));
    if (typeof win.addEventListener === 'function') win.addEventListener('storage', onStorage);

    const claude = win.claude;
    if (claude && typeof claude.use === 'function') {
      connecting = true;
      ready = connect(claude).catch(noop);
    } // plain localhost: this device is the only place games live, so no banner
  }

  async function connect(claude) {
    let found = null;
    try {
      found = await claude.use('db');
    } catch (e) { /* same as null */ }
    connecting = false;
    if (!found) {
      queued = null;
      setStatus(MSG_LOCAL);
      return;
    }
    db = found;
    store.mode = 'shared';
    timer = setTimeout(() => { timer = null; setStatus(MSG_UNREACHABLE); }, REACH_TIMEOUT);
    try {
      gameRef = db.doc('games/current');
      pump(); // edits made while connecting go up first; snapshots are ignored until they land
      gameRef.onSnapshot(onGameSnap, onSubscribeError);
      db.collection('history').orderBy('endedAt', 'desc').onSnapshot(onHistorySnap, onSubscribeError);
    } catch (e) {
      onSubscribeError();
    }
  }

  function heard(snap) {
    if (snap.metadata && snap.metadata.fromCache) return;
    if (timer) { clearTimeout(timer); timer = null; }
    if (status === MSG_UNREACHABLE) setStatus('');
  }

  function onSubscribeError() {
    if (timer) { clearTimeout(timer); timer = null; }
    setStatus(MSG_UNREACHABLE);
  }

  function onGameSnap(snap) {
    heard(snap);
    // Our own echo, or a remote state older than our unsaved edits: local wins.
    if (inFlight || queued != null || (snap.metadata && snap.metadata.hasPendingWrites)) return;
    const g = clone(snap.data());
    if (!isGame(g)) return; // no doc yet (or a malformed one): keep the local copy
    write(GAME_KEY, g);
    cb.onGame(g);
  }

  function onHistorySnap(snap) {
    heard(snap);
    // An empty cached view says nothing yet; don't wipe this device's copy with it.
    if (snap.metadata && snap.metadata.fromCache && !snap.docs.length) return;
    historyIds = new Set(snap.docs.map((d) => d.id));
    history = newestFirst(snap.docs.map((d) => Object.assign(clone(d.data()), { id: d.id })));
    write(HIST_KEY, history);
    cb.onHistory(clone(history));
  }

  function onStorage(e) {
    // key null = another window cleared localStorage.
    if ((e.key === GAME_KEY || e.key === null) && !inFlight && queued == null) cb.onGame(readGame());
    if (e.key === HIST_KEY || e.key === null) {
      history = newestFirst(read(HIST_KEY));
      cb.onHistory(clone(history));
    }
  }

  function saveGame(state) {
    const data = clone(state);
    write(GAME_KEY, data);
    if (!db && !connecting) return;
    queued = data; // only the latest state matters
    pump();
  }

  // One games/current write at a time; the newest queued state goes next.
  function pump() {
    if (!gameRef || inFlight || queued == null) return;
    const data = queued;
    queued = null;
    inFlight = true;
    Promise.resolve()
      .then(() => gameRef.set(data))
      .then(() => settled(true), () => settled(false));
  }

  function settled(ok) {
    inFlight = false;
    pump();
    if (!ok) setStatus(MSG_SAVE_FAIL);
    else if (status === MSG_SAVE_FAIL) setStatus('');
  }

  // A history write: op() goes to the db when shared, then next(op's answer) is this device's new list.
  function change(op, next) {
    return ready
      .then(() => db && op())
      .then((out) => {
        history = newestFirst(next(out));
        write(HIST_KEY, history);
        cb.onHistory(clone(history));
      }, (err) => {
        setStatus(MSG_SAVE_FAIL);
        throw err;
      });
  }

  // Resolves with the new record's id.
  function addGame(record) {
    const rec = bare(record);
    let id;
    return change(() => db.collection('history').add(rec), (ref) => {
      id = ref ? ref.id : newId();
      // The history snapshot may already carry the new doc.
      return ref && historyIds.has(id) ? history : [Object.assign({}, rec, { id })].concat(history);
    }).then(() => id);
  }

  // Replaces a finished game's record (settled marks, corrected results).
  function updateGame(id, record) {
    const rec = bare(record);
    return ready.then(() => {
      if (!history.some((r) => r.id === id)) throw gone();
      return change(() => db.collection('history').doc(id).set(rec),
        () => history.map((r) => (r.id === id ? Object.assign({}, rec, { id }) : r)));
    });
  }

  function deleteGame(id) {
    return change(() => db.collection('history').doc(id).delete(), () => history.filter((r) => r.id !== id));
  }
});
