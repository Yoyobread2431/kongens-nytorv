// PokerOnline: Supabase sign-in, invites, and `store`, an online twin of PokerStore backed by the `games` table.
// Browser: load supabase-js and online/config.js first; defines global PokerOnline.
// Node (tests): exports the factory, call it with a fake window ({ KN_CONFIG, supabase, localStorage, crypto }).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.PokerOnline = factory(root);
})(this, function (win) {
  'use strict';

  const GAME_KEY = 'kn.online.game.v1';     // { id, rev, status, state }: the current game row
  const HIST_KEY = 'kn.online.history.v1';  // [[gameId, GameRecord], ...]
  const ADMIN_KEY = 'kn.online.admin.v1';   // user id last confirmed as a host
  const MSG_OFF = 'Online sync is not set up.';
  const MSG_SIGNED_OUT = 'Sign in to see your games.';
  const MSG_UNREACHABLE = "Can't reach saved games right now. Showing this device's copy.";
  const MSG_SAVE_FAIL = "Couldn't save. Check your connection.";
  const MSG_READ_ONLY = 'Only the host can change the game.';
  const RUNNING = ['setup', 'live'];
  const ROW = 'id, rev, status, invite_code';
  // SQLSTATEs raised by claim_player / game_by_code (schema.sql), and what to tell the player.
  const ERRORS = {
    KN401: ['signed_out', 'Sign in first.'],
    KN404: ['bad_code', "This invite link doesn't work. Ask the host for a new one."],
    KN400: ['bad_name', 'Names are 1 to 30 characters.'],
    KN409: ['taken', 'Someone else already picked that name. Pick another one, or ask the host.'],
    42501: ['signed_out', 'Sign in first.'],
  };

  const noop = () => {};
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const isGame = (g) => !!g && typeof g === 'object' && Array.isArray(g.players);
  const isObj = (v) => !!v && typeof v === 'object';
  const newestFirst = (list) => list.slice().sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
  const blank = (id = null) => ({ id, rev: 0, status: null, code: null }); // rev 0 = not on the server yet

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

  const cfg = win.KN_CONFIG || {};
  const configured = !!(cfg.url && cfg.anonKey);
  const lib = win.supabase;
  const sb = configured && lib && typeof lib.createClient === 'function' ? lib.createClient(cfg.url, cfg.anonKey) : null;

  function need() {
    if (sb) return sb;
    throw new Error(configured ? "Couldn't load the online library. Check your connection." : MSG_OFF);
  }
  // supabase-js answers { data, error }; turn the error into a throw.
  async function must(query) {
    const { data, error } = await query;
    if (error) throw error;
    return data;
  }
  function friendly(error) {
    const [code, message] = ERRORS[error && error.code] || ['failed', 'Something went wrong. Try again.'];
    return Object.assign(new Error(message), { code, cause: error });
  }

  // ---------- auth and invites ----------

  async function signIn(email, redirectTo) {
    await must(need().auth.signInWithOtp({ email: String(email || '').trim(), options: { emailRedirectTo: redirectTo } }));
  }

  async function signOut() {
    await must(need().auth.signOut());
    for (const k of [GAME_KEY, HIST_KEY, ADMIN_KEY]) {
      try { win.localStorage.removeItem(k); } catch (e) { /* nothing cached */ }
    }
  }

  // cb(user or null): once with the current user, then each time a different user signs in or out.
  function onAuth(cb) {
    if (!sb) { cb(null); return noop; }
    let last; // undefined until the first answer
    const { data } = sb.auth.onAuthStateChange((event, session) => {
      const user = session ? session.user : null;
      const id = user ? user.id : null;
      if (id === last) return; // token refreshes and tab refocus repeat the same user
      last = id;
      setTimeout(() => cb(user), 0); // supabase-js: don't call the client from inside this callback
    });
    return () => data.subscription.unsubscribe();
  }

  async function user() {
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data && data.session ? data.session.user : null;
  }

  async function isAdmin() {
    return (await must(need().rpc('is_admin'))) === true;
  }

  // This user's player row { id, name, user_id }, or null before they claim one.
  async function myPlayer() {
    const u = await user();
    if (!u) return null;
    return must(need().from('players').select('id, name, user_id').eq('user_id', u.id).maybeSingle());
  }

  // Errors carry .code: 'taken', 'bad_code', 'bad_name', 'signed_out' or 'failed'.
  async function claim(code, name) {
    const { data, error } = await need().rpc('claim_player', { code, player_name: name });
    if (error) throw friendly(error);
    return data;
  }

  // { name, status, players: [{ name, claimed }] }, or null for a wrong code.
  async function gameByCode(code) {
    const { data, error } = await need().rpc('game_by_code', { code });
    if (error) throw friendly(error);
    return data || null;
  }

  // The current game's invite code, once its first save has reached the server (null when there is none).
  async function inviteCode() {
    await chain;
    return cur.code;
  }

  // ---------- store: same interface and semantics as PokerStore ----------

  let cb = { onGame: noop, onHistory: noop, onStatus: noop };
  let started = false;
  let status = '';
  let cur = blank();       // the games row holding the current game
  let game = null;         // the current game state, as last saved or received
  let done = new Map();    // games id -> GameRecord, for every finished game
  let admin = null;        // null until known
  let uid = null;
  let ready = Promise.resolve();
  let chain = Promise.resolve(); // every write runs here, one at a time, in call order
  let pending = null;      // latest state waiting to be written
  let queued = false;      // a write of `pending` is waiting in the chain
  let writing = false;     // a write is in flight
  let loads = 0;

  const store = { mode: 'local', init, saveGame, addGame };
  const busy = () => writing || queued;

  function setStatus(text) {
    if (text === status) return;
    status = text;
    cb.onStatus(text);
  }

  function keepGame() {
    write(GAME_KEY, { id: cur.id, rev: cur.rev, status: cur.status, code: cur.code, state: game });
  }
  function emitHistory() {
    write(HIST_KEY, [...done]);
    cb.onHistory(newestFirst([...done.values()]).map(clone));
  }
  function showGame(row) {
    cur = row ? { id: row.id, rev: row.rev, status: row.status, code: row.invite_code || (row.id === cur.id ? cur.code : null) } : blank();
    game = row ? clone(row.state) : null;
    keepGame();
    cb.onGame(clone(game));
  }

  function init(opts) {
    if (started) return;
    started = true;
    opts = opts || {};
    cb = { onGame: opts.onGame || noop, onHistory: opts.onHistory || noop, onStatus: opts.onStatus || noop };

    const cached = read(GAME_KEY);
    if (cached && isGame(cached.state)) {
      cur = { id: cached.id || null, rev: cached.rev || 0, status: cached.status || null, code: cached.code || null };
      game = cached.state;
    }
    const hist = read(HIST_KEY);
    done = new Map((Array.isArray(hist) ? hist : []).filter((e) => Array.isArray(e) && isObj(e[1])));
    cb.onGame(clone(game));
    cb.onHistory(newestFirst([...done.values()]).map(clone));
    ready = connect().catch(() => setStatus(MSG_UNREACHABLE));
  }

  async function connect() {
    if (!sb) { admin = false; setStatus(configured ? MSG_UNREACHABLE : MSG_OFF); return; }
    const u = await user();
    if (!u) { admin = false; setStatus(MSG_SIGNED_OUT); return; }
    uid = u.id;
    admin = read(ADMIN_KEY) === uid; // best guess until the server answers, so an offline host can still try
    store.mode = 'shared';
    try {
      sb.channel('games')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'games' }, onChange)
        .subscribe((s) => {
          if (s === 'SUBSCRIBED') load(); // also after a reconnect: catch up on what we missed
          else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') setStatus(MSG_UNREACHABLE);
        });
    } catch (e) { /* no live updates (e.g. WebSocket blocked); loading and saving still work */ }
    await load();
  }

  async function load() {
    const n = ++loads;
    try {
      const [adm, running, ended] = await Promise.all([
        isAdmin(),
        must(sb.from('games').select(ROW + ', state').in('status', RUNNING).order('created_at', { ascending: false }).limit(1)),
        // shortcut: PostgREST returns at most 1000 rows by default; page this past ~1000 finished games.
        must(sb.from('games').select('id, result').eq('status', 'done')),
      ]);
      admin = adm; // kept even from a stale load: the first save waits on it
      write(ADMIN_KEY, adm ? uid : null);
      if (n !== loads) return; // a newer load is on its way
      done = new Map(ended.filter((r) => isObj(r.result)).map((r) => [r.id, r.result]));
      emitHistory();
      if (done.has(cur.id)) cur.status = 'done';
      if (running[0]) takeRow(running[0], true);
      else if (!busy()) {
        // A game that never reached the server (offline since it started): push it instead of dropping it.
        if (admin && game && RUNNING.includes(game.phase) && !cur.rev) saveGame(game);
        else if (cur.id || game) showGame(null);
      }
      if (status === MSG_UNREACHABLE || status === MSG_SIGNED_OUT) setStatus('');
    } catch (e) {
      if (n === loads) setStatus(MSG_UNREACHABLE);
    }
  }

  function onChange(p) {
    if (p.eventType === 'DELETE') {
      const id = p.old && p.old.id;
      if (done.delete(id)) emitHistory();
      if (id && id === cur.id && !busy()) showGame(null);
      return;
    }
    const row = p.new || {};
    if (row.status !== 'done') { if (done.delete(row.id)) emitHistory(); }
    else if (isObj(row.result)) { done.set(row.id, row.result); emitHistory(); } // big unchanged jsonb can be left out
    if (row.id === cur.id && row.status === 'done') cur.status = 'done';
    takeRow(row, p.eventType === 'INSERT');
  }

  // Show a row's game, unless our own edits are unsaved or the row is old news.
  function takeRow(row, takeOver) {
    if (busy() || !isGame(row.state)) return;
    if (row.id === cur.id) { if (row.rev <= cur.rev) return; } // our own echo, or older than what we have
    else if (!takeOver || !RUNNING.includes(row.status)) return;
    showGame(row);
  }

  // Each write takes its turn after the ones before it, once we know whether this user is a host.
  function run(job) {
    const p = chain.then(() => ready).then(job);
    chain = p.catch(noop);
    return p;
  }
  async function saving(fn) {
    writing = true;
    try {
      const out = await fn();
      if (status === MSG_SAVE_FAIL) setStatus('');
      return out;
    } catch (e) {
      setStatus(MSG_SAVE_FAIL);
      throw e;
    } finally {
      writing = false;
    }
  }
  function kept(row) {
    cur = { id: row.id, rev: row.rev, status: row.status, code: row.invite_code };
    keepGame();
  }

  function saveGame(state) {
    if (admin === false) { setStatus(MSG_READ_ONLY); return; }
    game = clone(state);
    keepGame();
    pending = game;
    if (queued) return; // the queued write will pick up this newer state
    queued = true;
    run(flush).catch(noop);
  }

  async function flush() {
    const data = pending;
    queued = false;
    pending = null;
    if (!admin) { setStatus(MSG_READ_ONLY); return; }
    await saving(async () => {
      const phase = data && data.phase;
      if (phase !== 'setup' && phase !== 'live' && phase !== 'done') {
        // The game was closed: delete it if it never finished (the app's "delete game"), keep it if it did.
        if (cur.id && cur.status !== 'done') await must(sb.from('games').delete().eq('id', cur.id).in('status', RUNNING));
        cur = blank();
        keepGame();
        return;
      }
      if (!cur.id || (cur.status === 'done' && phase !== 'done')) cur = blank(win.crypto.randomUUID()); // a new game
      kept(await must(sb.from('games').upsert({ id: cur.id, status: phase, state: data }).select(ROW).single()));
    });
  }

  function addGame(record) {
    const rec = clone(record);
    return run(async () => {
      if (!admin) { setStatus(MSG_READ_ONLY); throw new Error(MSG_READ_ONLY); }
      if (!cur.id) cur = blank(win.crypto.randomUUID());
      const row = await saving(() => must(sb.from('games').upsert({
        id: cur.id, status: 'done', state: game || {}, result: rec,
        ended_at: new Date(rec.endedAt || Date.now()).toISOString(),
      }).select(ROW).single()));
      kept(row);
      done.set(row.id, rec);
      emitHistory();
    });
  }

  return { configured, signIn, signOut, onAuth, user, isAdmin, myPlayer, claim, gameByCode, inviteCode, store };
});
