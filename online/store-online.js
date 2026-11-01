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
  const MSG_GONE = "That game isn't saved any more.";
  const MSG_CONFLICT = "The game was changed on another device. Your last change wasn't saved: check it and do it again.";
  const RUNNING = ['setup', 'live'];
  const ROW = 'id, rev, status, invite_code';
  // SQLSTATEs raised by claim_player / game_by_code and the players table (schema.sql), and what to tell the player.
  const ERRORS = {
    KN401: ['signed_out', 'Sign in first.'],
    KN404: ['bad_code', "This invite link doesn't work. Ask the host for a new one."],
    KN400: ['bad_name', 'Names are 1 to 30 characters.'],
    KN409: ['taken', 'Someone else already picked that name. Pick another one, or ask the host.'],
    42501: ['signed_out', 'Sign in first.'],
    23505: ['already_linked', 'Your account is already linked to another player. Unlink that one first.'], // players.user_id is unique
    23514: ['bad_name', 'Names are 1 to 30 characters.'], // players.name check
  };

  const noop = () => {};
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const isGame = (g) => !!g && typeof g === 'object' && Array.isArray(g.players);
  const isObj = (v) => !!v && typeof v === 'object';
  const newestFirst = (list) => list.slice().sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
  const blank = (id = null) => ({ id, rev: 0, status: null, code: null }); // rev 0 = not on the server yet
  // A record as the result jsonb keeps it: the games row id is the record's id.
  const bare = (record) => { const r = clone(record) || {}; delete r.id; return r; };
  const oops = (code, message) => Object.assign(new Error(message), { code });
  const readOnly = () => oops('read_only', MSG_READ_ONLY);

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
    return Object.assign(oops(code, message), { cause: error });
  }
  // Like must, but the error comes out friendly.
  async function ask(query) {
    const { data, error } = await query;
    if (error) throw friendly(error);
    return data;
  }

  // ---------- auth and invites ----------

  async function signIn(email, redirectTo) {
    await must(need().auth.signInWithOtp({ email: String(email || '').trim(), options: { emailRedirectTo: redirectTo } }));
  }

  // Email + password, so no email is ever sent (Supabase "Confirm email" is turned off for this project).
  const AUTH_ERRORS = {
    invalid_credentials: 'Wrong email or password. New here? Tap Create account.',
    user_already_exists: 'That email already has an account. Tap Sign in instead.',
    weak_password: 'Pick a longer password (at least 6 characters).',
    email_address_invalid: "That email address doesn't look right.",
    over_request_rate_limit: 'Too many tries. Wait a minute and try again.',
  };
  const authError = error => Object.assign(
    new Error(AUTH_ERRORS[error && error.code] || (error && error.message) || 'Something went wrong. Try again.'),
    { code: (error && error.code) || 'failed', cause: error });
  async function signInPassword(email, password) {
    const { error } = await need().auth.signInWithPassword({ email: String(email || '').trim(), password: String(password || '') });
    if (error) throw authError(error);
  }
  async function setPassword(password) { // for accounts made with an email link, and for changing it later
    const { error } = await need().auth.updateUser({ password: String(password || '') });
    if (error) throw authError(error);
  }
  async function signUp(email, password) {
    const { data, error } = await need().auth.signUp({ email: String(email || '').trim(), password: String(password || '') });
    if (error) throw authError(error);
    if (!data || !data.session) { // Supabase still wants an email confirmation, which can't be sent
      throw Object.assign(new Error('Account made, but the app still asks for an email confirmation. The host must turn off "Confirm email" in Supabase.'), { code: 'confirm_required' });
    }
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

  // A link for the whole group, not only tonight's game: the current game's code, else the newest game's.
  // Any game's code lets a friend join (claim_player), as long as that game isn't deleted.
  async function groupInviteCode() {
    const code = await inviteCode();
    if (code) return code;
    const rows = await ask(need().from('games').select('invite_code').order('created_at', { ascending: false }).limit(1));
    return (rows && rows[0] && rows[0].invite_code) || null;
  }

  // ---------- player profiles: members read them, hosts change them ----------
  // Errors carry .code: 'read_only', 'taken', 'already_linked', 'bad_name', 'signed_out' or 'failed'.

  const PLAYER = 'id, name, user_id';
  const sameName = (a, b) => a.toLowerCase() === b.toLowerCase(); // players_lower_name_key

  async function asHost() {
    if (admin !== true && (await ask(need().rpc('is_admin'))) !== true) throw readOnly();
  }

  async function listPlayers() {
    return (await ask(need().from('players').select(PLAYER))).sort((a, b) => a.name.localeCompare(b.name));
  }

  // Saves the names not saved yet, and resolves with the rows for all of them, in the given order.
  async function addPlayers(names) {
    await asHost();
    const want = (names || []).map((n) => String(n || '').trim()).filter(Boolean);
    let rows = await listPlayers();
    const fresh = want.filter((n) => !rows.some((r) => sameName(r.name, n)));
    for (const name of fresh) {
      const { error } = await need().from('players').insert({ name });
      if (error && error.code !== '23505') throw friendly(error); // 23505: someone saved that name a moment ago
    }
    if (fresh.length) rows = await listPlayers();
    return want.map((n) => rows.find((r) => sameName(r.name, n))).filter(Boolean);
  }

  // Links the signed-in host's own account to a player nobody has linked yet.
  async function linkPlayer(playerId) {
    await asHost();
    const u = await user();
    if (!u) throw oops('signed_out', 'Sign in first.');
    const row = await ask(need().from('players').update({ user_id: u.id })
      .eq('id', playerId).is('user_id', null).select(PLAYER).maybeSingle());
    if (!row) throw oops('taken', 'That player is already linked to someone else.');
    return row;
  }

  async function unlinkPlayer(playerId) {
    await asHost();
    await ask(need().from('players').update({ user_id: null }).eq('id', playerId));
  }

  async function removePlayer(playerId) {
    await asHost();
    await ask(need().from('players').delete().eq('id', playerId));
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
  let unsent = false;      // the last save of the game didn't reach the server: push it again on the next load
  let loaded = false;      // the first full load is done (later loads are reconnects, e.g. after a phone wakes up)

  const store = { mode: 'local', init, saveGame, addGame, updateGame, deleteGame };
  const busy = () => writing || queued;

  function setStatus(text) {
    if (text === status) return;
    status = text;
    cb.onStatus(text);
  }

  function keepGame() {
    write(GAME_KEY, { id: cur.id, rev: cur.rev, status: cur.status, code: cur.code, state: game });
  }
  const records = () => newestFirst([...done].map(([id, r]) => Object.assign(clone(r), { id })));
  function emitHistory() {
    write(HIST_KEY, [...done]);
    cb.onHistory(records());
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
    cb.onHistory(records());
    ready = connect().catch(() => setStatus(MSG_UNREACHABLE));
  }

  async function connect() {
    if (!sb) { admin = false; setStatus(configured ? MSG_UNREACHABLE : MSG_OFF); return; }
    const u = await user();
    if (!u) { admin = false; setStatus(MSG_SIGNED_OUT); return; }
    uid = u.id;
    // Best guess until the server answers: "host" if this device remembers this user as host, otherwise
    // "unknown" (never "not host"), so a save made in the first second waits for the answer instead of being dropped.
    admin = read(ADMIN_KEY) === uid ? true : null;
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
      const first = !loaded;
      loaded = true;
      done = new Map(ended.filter((r) => isObj(r.result)).map((r) => [r.id, r.result]));
      emitHistory();
      if (done.has(cur.id)) cur.status = 'done';
      if (unsent && admin && game && !busy()) saveGame(game); // a save that failed earlier: send it now
      else if (running[0]) takeRow(running[0], true);
      else if (!busy()) {
        // A game that never reached the server (offline since it started): push it instead of dropping it.
        if (admin && game && RUNNING.includes(game.phase) && !cur.rev) saveGame(game);
        // No game running on the server. On a reconnect, a game that just finished stays on screen (its results).
        else if ((cur.id || game) && (first || cur.status !== 'done')) showGame(null);
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
      if (status === MSG_SAVE_FAIL || status === MSG_CONFLICT) setStatus('');
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
    if (admin === false) { setStatus(MSG_READ_ONLY); return; }
    if (admin !== true) { unsent = true; setStatus(MSG_UNREACHABLE); return; } // host check didn't get through: keep it for the next load
    unsent = true; // until the server confirms
    let clash = false;
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
      if (!cur.rev) { kept(await must(sb.from('games').upsert({ id: cur.id, status: phase, state: data }).select(ROW).single())); return; }
      // Only on top of the version this device last saw. Otherwise another host device (or this phone, before it
      // woke up and caught up) changed the game since, and writing the whole game would wipe that change.
      const row = await must(sb.from('games').update({ status: phase, state: data }).eq('id', cur.id).eq('rev', cur.rev).select(ROW).maybeSingle());
      if (row) kept(row); else clash = true;
    });
    unsent = false;
    if (clash) { setStatus(MSG_CONFLICT); load(); } // show the newer game
  }

  function hostOnly() {
    if (!admin) { setStatus(MSG_READ_ONLY); throw readOnly(); }
  }

  // Resolves with the games row id, which is the record's id in onHistory.
  function addGame(record) {
    const rec = bare(record);
    return run(async () => {
      hostOnly();
      if (!cur.id) cur = blank(win.crypto.randomUUID());
      const row = await saving(() => must(sb.from('games').upsert({
        id: cur.id, status: 'done', state: game || {}, result: rec,
        ended_at: new Date(rec.endedAt || Date.now()).toISOString(),
      }).select(ROW).single()));
      kept(row);
      done.set(row.id, rec);
      emitHistory();
      return row.id;
    });
  }

  // Replaces a finished game's record (settled marks, corrected results). Leaves its `state` as it was.
  function updateGame(id, record) {
    const rec = bare(record);
    return run(async () => {
      hostOnly();
      const row = await saving(() => must(sb.from('games').update({ result: rec })
        .eq('id', id).eq('status', 'done').select('id, rev').maybeSingle()));
      if (!row) throw oops('not_found', MSG_GONE);
      if (row.id === cur.id) { cur.rev = row.rev; keepGame(); } // so its realtime echo counts as our own
      done.set(row.id, rec);
      emitHistory();
    });
  }

  function deleteGame(id) {
    return run(async () => {
      hostOnly();
      await saving(() => must(sb.from('games').delete().eq('id', id).eq('status', 'done')));
      if (done.has(id)) onChange({ eventType: 'DELETE', old: { id } }); // as its realtime echo will, which then finds nothing
    });
  }

  return {
    configured, signIn, signInPassword, signUp, setPassword, signOut, onAuth, user, isAdmin, myPlayer, claim, gameByCode, inviteCode, groupInviteCode,
    listPlayers, addPlayers, linkPlayer, unlinkPlayer, removePlayer, store,
  };
});
