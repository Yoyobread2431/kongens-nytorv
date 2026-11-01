// Kongens Nytorv Home Games: connects index.html, PokerLogic and PokerStore. See SPEC.md.
// Tabs: Home, Leaderboard (players), Stats, Profile. Player pages and game dashboards open from them. A game goes: New game (setup) -> live (rebuys, cash outs, activity) -> results.
(() => {
  'use strict';
  const L = PokerLogic;
  // Online when online/config.js is filled in (the GitHub Pages site); otherwise this laptop only, as before.
  const ON = window.PokerOnline && PokerOnline.configured ? PokerOnline : null;
  const S = ON ? ON.store : PokerStore;
  const $ = id => document.getElementById(id);
  const clone = id => $(id).content.firstElementChild.cloneNode(true);
  const put = (root, sel, text) => { root.querySelector(sel).textContent = text; };
  const setVal = (el, v) => { if (document.activeElement !== el) el.value = v; };
  const lc = s => String(s).trim().toLowerCase();
  const initial = name => (String(name).trim()[0] || '?').toUpperCase();
  // Each player keeps one avatar color everywhere: a hue picked from their name.
  const HUES = [0, 22, 42, 95, 150, 178, 200, 222, 255, 285, 318];
  const hueOf = name => { let h = 0; for (const ch of lc(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0; return HUES[h % HUES.length]; };
  const paint = (el, name, empty = '?') => {
    el.textContent = name ? initial(name) : empty;
    el.classList.toggle('hue', !!name);
    if (name) el.style.setProperty('--h', hueOf(name));
    return el;
  };
  const plural = (n, w) => `${L.fmtMoney(n)} ${w}${n === 1 ? '' : 's'}`;
  const round = v => Math.round(v * 100) / 100;
  const cents = v => Math.round((v || 0) * 100);
  const amountVal = v => (v !== '' && +v > 0 ? round(+v) : null);
  const fmtDate = ms => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtShort = ms => (new Date(ms).toDateString() === new Date().toDateString()
    ? 'Today' : new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  const fmtClockTime = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const fmtDur = ms => {
    const m = Math.round((ms || 0) / 60000);
    return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  };

  // ---- money with a currency ----
  const CURRENCIES = { DKK: ['', ' kr'], USD: ['$', ''], EUR: ['€', ''], GBP: ['£', ''], SEK: ['', ' kr'], NOK: ['', ' kr'], CHIPS: ['', ''] };
  const CUR_NAMES = { DKK: 'DKK kr', USD: 'USD $', EUR: 'EUR €', GBP: 'GBP £', SEK: 'SEK kr', NOK: 'NOK kr', CHIPS: 'Chips' };
  const money = (n, c) => { const [a, b] = CURRENCIES[c] || CURRENCIES.DKK; return a + L.fmtMoney(n) + b; };
  const signed = (n, c) => { const s = L.fmtNet(n); return s === '0' ? money(0, c) : s[0] + money(Math.abs(n), c); };
  const tone = (el, n) => { el.classList.remove('up', 'down', 'even'); if (n !== null) el.classList.add(n > 0 ? 'up' : n < 0 ? 'down' : 'even'); };

  // ---- preferences and saved players (this browser only) ----
  const PREFS = 'pokerNight.prefs.v1', PROFILES = 'pokerNight.profiles.v1';
  const readJSON = (key, d) => { try { return JSON.parse(localStorage.getItem(key)) ?? d; } catch { return d; } };
  const writeJSON = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} };
  const prefs = { me: null, currency: 'DKK', buyIn: 200, ...readJSON(PREFS, {}) };
  if (!CURRENCIES[prefs.currency]) prefs.currency = 'DKK';
  if (!(prefs.buyIn > 0)) prefs.buyIn = 200;
  const savePrefs = () => writeJSON(PREFS, prefs);
  // Totals across games use the latest game's currency: friends can't pick one, and the host's setting is for new games.
  const totalsCur = () => games[0]?.currency || prefs.currency;
  let profiles = readJSON(PROFILES, []);
  profiles = (Array.isArray(profiles) ? profiles : []).filter(p => p && typeof p.name === 'string');
  const saveProfiles = () => writeJSON(PROFILES, profiles);
  // Group profiles. Online they are the shared players table (account = a friend linked to it); laptop-only, this browser's list.
  let onlinePlayers = null; // [{ id, name, user_id }] once loaded online
  const profileList = () => (onlinePlayers ? onlinePlayers.map(p => ({ id: p.id, name: p.name, account: !!p.user_id })) : profiles);
  const profileOf = name => profileList().find(p => lc(p.name) === lc(name));
  const savedName = name => profileOf(name)?.name;
  const remember = name => {
    if (savedName(name)) return;
    if (onlinePlayers) { // shown at once; the saved row replaces it when the server answers
      onlinePlayers.push({ id: null, name, user_id: null });
      if (host) ON.addPlayers([name]).then(refreshPlayers, () => {});
      return;
    }
    profiles.push({ name });
    profiles.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    saveProfiles();
  };
  const forgetProfile = name => { // profiles with an account stay: that's someone's account
    const p = profileOf(name);
    if (!p || p.account) return;
    if (onlinePlayers) { if (p.id) ON.removePlayer(p.id).then(refreshPlayers, err => flash(err.message || "Couldn't remove them")); return; }
    profiles = profiles.filter(x => x.name !== p.name);
    saveProfiles();
  };
  async function refreshPlayers() {
    if (!ON || !ON.listPlayers) return;
    try { onlinePlayers = await ON.listPlayers(); render(); } catch { /* keep what we have */ }
  }

  // ---- theme: index.html applies it before the first paint (saved choice, else the system setting); this is the toggle ----
  const THEME = 'pokerNight.theme', sysLight = matchMedia('(prefers-color-scheme: light)');
  const savedTheme = () => { try { const t = localStorage.getItem(THEME); return t === 'light' || t === 'dark' ? t : null; } catch { return null; } };
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    const next = `Switch to ${t === 'dark' ? 'light' : 'dark'} theme`;
    for (const b of document.querySelectorAll('.theme-toggle')) {
      b.setAttribute('aria-label', next);
      const label = b.querySelector('.t-label');
      if (label) label.textContent = next;
    }
  }
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  document.addEventListener('click', e => {
    if (!e.target.closest('.theme-toggle')) return;
    const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(THEME, t); } catch {}
    applyTheme(t);
  });
  sysLight.addEventListener('change', e => { if (!savedTheme()) applyTheme(e.matches ? 'light' : 'dark'); });
  window.addEventListener('storage', e => { if (e.key === THEME) applyTheme(savedTheme() || (sysLight.matches ? 'light' : 'dark')); });

  // ---- game state ----
  const PHASES = ['none', 'setup', 'live', 'done'];
  const fresh = () => ({
    phase: 'none', name: '', currency: prefs.currency, buyIn: prefs.buyIn, bombEvery: 0, bombsDone: 0,
    players: [], elapsed: 0, since: null, startedAt: null, result: null, practice: false, seated: false, dealer: null,
  });
  const fin = (v, d) => (Number.isFinite(v) ? v : d);
  const record = r => (r && typeof r === 'object' && Array.isArray(r.results) ? {
    name: typeof r.name === 'string' ? r.name : '', currency: CURRENCIES[r.currency] ? r.currency : prefs.currency,
    endedAt: fin(r.endedAt, 0), startedAt: fin(r.startedAt, null), duration: fin(r.duration, 0), pot: fin(r.pot, 0),
    results: r.results, transfers: Array.isArray(r.transfers) ? r.transfers : [],
    ...(typeof r.id === 'string' && r.id ? { id: r.id } : {}), ...(r.practice ? { practice: true } : {}),
  } : null);
  // Builds new objects, so frozen snapshot data is never mutated. Old saves ("counting" phase, no timestamps) still load.
  function normalize(g) {
    const d = fresh();
    if (!g || typeof g !== 'object') return d;
    const t0 = fin(g.startedAt, Date.now());
    const players = (Array.isArray(g.players) ? g.players : [])
      .filter(p => p && typeof p.name === 'string' && Array.isArray(p.buys))
      .map(p => {
        const count = Number.isFinite(p.count) && p.count >= 0 ? p.count : null;
        return {
          name: p.name,
          buys: p.buys.filter(b => b && typeof b === 'object').map(b => ({ money: Math.max(0, fin(b.money, 0)), at: fin(b.at, t0) })),
          count, outAt: count === null ? null : fin(p.outAt, t0),
        };
      })
      .filter(p => p.buys.length);
    const s = {
      phase: PHASES.includes(g.phase) ? g.phase : g.phase === 'counting' ? 'live' : 'none',
      name: typeof g.name === 'string' ? g.name : '',
      currency: CURRENCIES[g.currency] ? g.currency : prefs.currency,
      buyIn: fin(g.buyIn, 0) > 0 ? g.buyIn : d.buyIn,
      bombEvery: Math.max(0, fin(g.bombEvery, 0)),
      bombsDone: Math.max(0, fin(g.bombsDone, 0)),
      players,
      elapsed: Math.max(0, fin(g.elapsed, 0)),
      since: fin(g.since, null),
      startedAt: fin(g.startedAt, null),
      result: record(g.result),
      practice: !!g.practice,
      seated: !!g.seated,
      dealer: typeof g.dealer === 'string' ? g.dealer : null,
    };
    if (s.phase === 'done' && !s.result) s.phase = 'none';
    if (s.phase === 'live' && !players.length) s.phase = 'setup';
    return s;
  }

  let state = fresh(), games = [], storeStatus = '', appMsg = '', msgTimer = null, saving = false;
  // Online, friends are viewers and only the host changes games. `gate` is the sign-in / invite screen showing, if any.
  let host = !ON, me = null, account = '', gate = ON ? 'loading' : null, joinCodeShown = null;
  let tab = 'home', inGame = false, viewing = null, person = null, actFilter = null, statWho = '', boardSort = 'net', boardPeriod = 'all';
  const save = () => { dropUndo(); S.saveGame(state); }; // any new change ends the chance to undo the last one
  const commit = () => { save(); render(); };
  const C = () => state.currency;
  const elapsedNow = () => state.elapsed + (state.since ? Date.now() - state.since : 0);
  const pause = () => { if (state.since) { state.elapsed = elapsedNow(); state.since = null; } };
  const findPlayer = name => state.players.find(p => lc(p.name) === lc(name));
  const inPlay = () => (cents(L.totals(state.players).money) - state.players.reduce((s, p) => s + cents(p.count), 0)) / 100;
  const isTable = () => location.hash === '#table';
  const running = () => state.phase === 'setup' || state.phase === 'live';

  // Two taps to confirm: the first arms the button for 3 s.
  function twoTap(btn, armedText, action) {
    let timer = null, label = '';
    const disarm = () => {
      if (!timer) return;
      clearTimeout(timer); timer = null; btn.textContent = label; btn.classList.remove('armed');
    };
    btn.addEventListener('click', () => {
      if (!timer) { label = btn.textContent; btn.textContent = armedText; btn.classList.add('armed'); timer = setTimeout(disarm, 3000); return; }
      disarm();
      action();
    });
    return disarm;
  }

  // ---- bomb pots: due every N minutes of clock time (pausing pauses them too) ----
  const bombMs = () => state.bombEvery * 60000;
  const bombLeft = () => (state.phase === 'live' && state.bombEvery > 0 ? (state.bombsDone + 1) * bombMs() - elapsedNow() : null);
  let audio = null, beeped = null;
  const unlockAudio = () => { try { audio ??= new (window.AudioContext || window.webkitAudioContext)(); audio.resume?.(); } catch {} };
  function beep() {
    if (!audio) return;
    try {
      for (const at of [0, 0.35, 0.7]) {
        const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + at;
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        o.connect(g).connect(audio.destination);
        o.start(t);
        o.stop(t + 0.3);
      }
    } catch {}
  }

  // ---- toast ----
  function renderStatus() {
    const el = $('status');
    el.textContent = appMsg || storeStatus;
    el.hidden = !el.textContent;
  }
  function flash(msg) {
    appMsg = msg;
    renderStatus();
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { appMsg = ''; renderStatus(); }, 3500);
  }

  // ---- undo: the last rebuy, cash out, add or delete can be taken back for a few seconds ----
  let undoSnap = null, undoTimer = null;
  const snapshot = () => JSON.stringify(state);
  function offerUndo(snap, text) { // call after commit(), which drops the previous offer
    undoSnap = snap;
    $('undoText').textContent = text;
    $('undoBar').hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(dropUndo, 8000);
  }
  function dropUndo() {
    undoSnap = null;
    clearTimeout(undoTimer);
    $('undoBar').hidden = true;
  }
  $('undoBtn').addEventListener('click', () => {
    const snap = undoSnap;
    if (!snap || !host || saving) return; // not while the finished game is being saved
    state = normalize(JSON.parse(snap));
    if (running()) { inGame = true; viewing = null; person = null; }
    commit();
    flash('Undone');
  });

  // ---- keep the screen on during a game, so phones and laptops at the table don't dim and lock ----
  let wake = null, wakeAsking = false;
  function syncWake() {
    if (!navigator.wakeLock) return;
    const v = currentView();
    const want = document.visibilityState === 'visible' && !gate
      && (v === 'viewLive' || v === 'viewTable' || v === 'viewSetup' || (host && state.phase === 'live'));
    if (want && !wake && !wakeAsking) {
      wakeAsking = true;
      navigator.wakeLock.request('screen').then(l => {
        wakeAsking = false;
        wake = l;
        l.addEventListener('release', () => { if (wake === l) wake = null; }); // the browser lets go when the tab is hidden
        syncWake(); // still wanted?
      }, () => { wakeAsking = false; }); // not allowed (battery saver, old browser): the screen just sleeps as usual
    } else if (!want && wake) {
      const l = wake;
      wake = null;
      l.release().catch(() => {});
    }
  }
  document.addEventListener('visibilitychange', syncWake);

  // ---- views ----
  const TABS = { home: 'viewHome', players: 'viewPlayers', stats: 'viewStats', profile: 'viewProfile' };
  const VIEWS = ['viewGate', 'viewHome', 'viewPlayers', 'viewStats', 'viewProfile', 'viewPerson', 'viewSetup', 'viewLive', 'viewResults', 'viewTable'];
  function currentView() {
    if (gate) return 'viewGate';
    if (isTable()) return 'viewTable';
    if (viewing) return 'viewResults';
    if (person) return 'viewPerson';
    // Viewers watch a game being set up on the (read-only) live screen.
    if (inGame && state.phase !== 'none') return { setup: host ? 'viewSetup' : 'viewLive', live: 'viewLive', done: 'viewResults' }[state.phase];
    return TABS[tab];
  }
  function go(newTab) {
    tab = newTab; viewing = null; person = null; inGame = false;
    render();
    window.scrollTo(0, 0);
  }
  // Sub-pages: a player's page, a finished game's dashboard. Back from a game returns to the player page it came from.
  const openPerson = name => { person = name; viewing = null; render(); window.scrollTo(0, 0); };
  const openGame = g => { viewing = g; render(); window.scrollTo(0, 0); };

  let dashAt = 0;
  function tick() {
    if (state.phase === 'live' && Date.now() - dashAt > 30000) { dashAt = Date.now(); renderDash(); }
    $('clock').textContent = $('bigClock').textContent = L.fmtTime(elapsedNow());
    const left = bombLeft(), due = left !== null && left <= 0;
    const text = left === null ? '' : due ? 'Bomb pot now!' : `Next bomb pot in ${L.fmtTime(left + 999).replace(/^0:/, '')}`;
    for (const [box, label] of [['bombPanel', 'bombText'], ['bigBomb', 'bigBombText']]) {
      $(box).hidden = left === null;
      $(box).classList.toggle('due', due);
      $(label).textContent = text;
    }
    $('bombDone').hidden = !due;
    if (!due) beeped = null;
    else if (beeped !== state.bombsDone) { beeped = state.bombsDone; if (!isTable()) beep(); }
  }

  function render() {
    const v = currentView(), onTab = Object.values(TABS).includes(v);
    document.body.classList.toggle('online', !!ON);
    document.body.classList.toggle('viewer', !host);
    for (const id of VIEWS) $(id).hidden = id !== v;
    renderGate();
    $('tabbar').hidden = !onTab;
    $('fab').hidden = v !== 'viewHome';
    $('dock').hidden = v !== 'viewLive';
    for (const b of $('tabbar').querySelectorAll('button')) {
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    renderHome();
    renderPlayers();
    renderStats();
    renderProfile();
    renderPerson();
    renderSetup();
    renderLive();
    renderResults();
    renderTable();
    tick();
    syncWake();
  }

  // ---- Home ----
  const IDEAS = [
    ['Bomb pot', 'Everyone antes and the hand starts on the flop. Turn on a bomb pot every 30 minutes in Game settings.'],
    ['Seven-deuce bounty', 'Win a hand with 7-2 and show it: every other player pays you a small bounty.'],
    ['Double board', 'Deal two boards each hand. The best hand on each board takes half the pot.'],
    ['Run it twice', 'When a player is all in, deal the rest of the board twice and split the pot between the two runs.'],
    ['Straddle orbit', 'For one round, the player after the big blind posts double the big blind and acts last before the flop.'],
  ];
  const fillStack = (el, names) => {
    el.replaceChildren(...names.slice(0, 3).map(n => paint(Object.assign(document.createElement('span'), { className: 'avatar' }), n)));
    if (names.length > 3) el.append(Object.assign(document.createElement('span'), { className: 'avatar more', textContent: `+${names.length - 3}` }));
  };
  function sessionCard(g) {
    const el = clone('tplSession'), net = el.querySelector('.s-net');
    if (!g) { // the game being set up or played now
      put(el, '.s-name', state.name || 'Home game');
      put(el, '.s-date', state.phase === 'live' ? 'Now' : 'Setting up');
      net.textContent = state.phase === 'live' ? `Pot ${money(L.totals(state.players).money, C())}` : plural(state.players.length, 'player');
      el.querySelector('.live').hidden = state.phase !== 'live';
      fillStack(el.querySelector('.stack'), state.players.map(p => p.name));
      el.addEventListener('click', () => { inGame = true; render(); window.scrollTo(0, 0); });
      return el;
    }
    const mine = prefs.me && g.results.find(r => lc(r.name) === lc(prefs.me));
    put(el, '.s-name', g.name || 'Home game');
    put(el, '.s-date', fmtShort(g.endedAt));
    if (mine) { net.textContent = signed(mine.net, g.currency); tone(net, mine.net); }
    else net.textContent = `Pot ${money(g.pot, g.currency)}`;
    el.querySelector('.live').hidden = true;
    fillStack(el.querySelector('.stack'), g.results.map(r => r.name));
    el.addEventListener('click', () => openGame(g));
    return el;
  }
  function renderHome() {
    // The big button: start a game, or jump back into the one that's running.
    const run = running();
    $('homeGame').classList.toggle('live', run);
    $('homeGameText').textContent = !run ? 'New game' : state.phase === 'live' ? 'Back to the game' : 'Continue setting up';
    $('homeGame').querySelector('.cta-plus').textContent = run ? '▶' : '+';
    const year = new Date().getFullYear(), me = prefs.me, c = totalsCur();
    const yr = games.filter(g => new Date(g.endedAt).getFullYear() === year);
    const num = $('yearNum');
    if (me) {
      const st = L.playerStats(games, me, new Date(year, 0, 1).getTime());
      $('yearLabel').textContent = `Your results in ${year}`;
      num.textContent = signed(st.net, c);
      tone(num, st.net);
      $('yearSub').textContent = plural(st.sessions, 'session');
    } else {
      $('yearLabel').textContent = `Played in ${year}`;
      num.textContent = money(yr.reduce((s, g) => s + cents(g.pot), 0) / 100, c);
      tone(num, null);
      $('yearSub').textContent = `${plural(yr.length, 'session')} · pick yourself in Profile to see your own results`;
    }
    // The last six months, as bars.
    const cols = [], byYear = {};
    for (let k = 5; k >= 0; k--) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - k); cols.push([d.getFullYear(), d.getMonth()]); }
    const vals = cols.map(([y, m]) => (byYear[y] ??= L.monthly(games, y, me || undefined))[m]);
    const max = Math.max(1, ...vals.map(Math.abs));
    $('yearBars').replaceChildren(...cols.map(([y, m], i) => {
      const div = document.createElement('div'), bar = document.createElement('i'), lab = document.createElement('small');
      bar.style.height = `${Math.max(2, (Math.abs(vals[i]) / max) * 100)}%`;
      if (vals[i] < 0) bar.className = 'neg';
      lab.textContent = new Date(y, m, 1).toLocaleDateString('en-US', { month: 'short' });
      div.append(bar, lab);
      return div;
    }));
    renderPotm();
    const cards = [...(running() ? [sessionCard(null)] : []), ...games.slice(0, 12).map(sessionCard)];
    $('sessions').replaceChildren(...cards);
    $('sessions').hidden = !cards.length;
    $('sessionsEmpty').hidden = cards.length > 0;
    $('sessionsEmpty').textContent = host ? 'No games yet. Tap New game to start the first one.' : 'No games yet. They show up here when the host starts one.';
  }

  // Player of the month: this month's biggest winner so far, or last month's early in a month before anyone is up.
  function renderPotm() {
    const now = new Date(), monthName = d => d.toLocaleDateString('en-US', { month: 'long' });
    const last = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    const pick = [[now, `Player of the month · ${monthName(now)}`], [last, `Last month's champ · ${monthName(last)}`]]
      .map(([d, label]) => ({ label, top: L.leaderboard(L.inPeriod(games, 'month', d.getTime()))[0] }))
      .find(x => x.top && x.top.net > 0);
    $('potm').hidden = !pick;
    if (!pick) return;
    const t = pick.top;
    $('potmLabel').textContent = pick.label;
    paint($('potmAv'), t.name);
    $('potmName').textContent = t.name;
    $('potmMeta').textContent = `${plural(t.games, 'game')} · ${plural(t.wins, 'win')}`;
    $('potmNet').textContent = signed(t.net, totalsCur());
    $('potm').dataset.name = t.name;
  }

  // ---- Leaderboard tab: podium for the top 3, the rest ranked, then saved players with no games ----
  const BOARD_HINT = { net: 'Total profit', avg: 'Average result per game · 3+ games ranked first', games: 'Games played' };
  function boardValue(el, r, c) {
    const v = boardSort === 'avg' ? Math.round(r.avg) : r.net;
    el.textContent = boardSort === 'games' ? plural(r.games, 'game') : signed(v, c);
    tone(el, boardSort === 'games' ? null : v);
  }
  const streakTag = (el, r) => {
    el.hidden = !r.streak;
    if (!r.streak) return;
    el.textContent = r.streak > 0 ? `W${r.streak}` : `L${-r.streak}`;
    el.className = `streak ${r.streak > 0 ? 'win' : 'loss'}`;
  };
  const PERIOD_HINT = { month: ' · this month', year: ' · this year', all: ' · all time' };
  function renderPlayers() {
    const board = L.rank(L.leaderboard(L.inPeriod(games, boardPeriod)), boardSort), seen = new Set(board.map(r => lc(r.name))), c = totalsCur();
    for (const b of $('boardSort').children) b.setAttribute('aria-pressed', String(b.dataset.sort === boardSort));
    for (const b of $('boardPeriod').children) b.setAttribute('aria-pressed', String(b.dataset.period === boardPeriod));
    $('boardPeriod').hidden = !games.length;
    $('boardSort').hidden = $('boardHint').hidden = !board.length;
    $('boardHint').textContent = BOARD_HINT[boardSort] + PERIOD_HINT[boardPeriod];
    $('podium').replaceChildren(...board.slice(0, 3).map((r, i) => {
      const el = clone('tplPodium');
      paint(el.querySelector('.avatar'), r.name);
      put(el, '.name', r.name);
      put(el, '.step', i + 1);
      boardValue(el.querySelector('.net'), r, c);
      el.dataset.name = r.name;
      el.setAttribute('aria-label', `Number ${i + 1}, ${r.name}: open their page`);
      return el;
    }));
    // Saved players with no games show on All time only; in a month or year they may well have played before.
    const idle = boardPeriod === 'all' ? profileList().filter(p => !seen.has(lc(p.name))).map(p => ({ name: p.name, games: 0 })) : [];
    const rows = [...board.slice(3), ...idle];
    $('playerList').replaceChildren(...rows.map((r, i) => {
      const li = clone('tplPlayerRow'), btn = li.querySelector('.row-item'), x = li.querySelector('[data-act="forget"]'), net = li.querySelector('.net');
      put(li, '.rank', r.games ? i + 4 : '');
      paint(li.querySelector('.avatar'), r.name);
      put(li, '.name', r.name);
      put(li, '.meta', (r.games ? `${plural(r.games, 'game')} · ${plural(r.wins, 'win')}` : 'No games yet') + (profileOf(r.name)?.account ? ' · ✓ account' : ''));
      streakTag(li.querySelector('.streak'), r);
      if (r.games) boardValue(net, r, c); else net.textContent = '';
      btn.dataset.name = x.dataset.name = r.name;
      btn.setAttribute('aria-label', `${r.name}: open their page`);
      x.hidden = r.games > 0 || !savedName(r.name) || !!profileOf(r.name)?.account; // games and accounts stay
      x.setAttribute('aria-label', `Forget ${r.name}`);
      return li;
    }));
    $('playerList').hidden = !rows.length;
    $('playersEmpty').hidden = rows.length + board.length > 0;
    $('playersEmpty').textContent = boardPeriod !== 'all' && games.length
      ? `No games ${boardPeriod === 'month' ? 'this month' : 'this year'} yet.` : 'No players yet. Everyone you add to a game is saved here.';
  }

  // ---- Charts: hand-written SVG drawn at the element's pixel size, so text and dots stay crisp ----
  const esc = v => String(v).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  const dir = n => (cents(n) > 0 ? 'up' : cents(n) < 0 ? 'down' : 'even');
  const f1 = n => n.toFixed(1);
  const charts = new WeakMap(); // chart wrap -> what the tooltip needs

  // Running total: starts at 0, a green segment after a win, red after a loss, one dot per game. Tap or hover for details.
  function lineChart(wrap, series, c) {
    const svg = wrap.querySelector('svg'), W = Math.round(wrap.clientWidth), H = Math.round(wrap.clientHeight);
    if (!W) return; // hidden: drawn when it shows
    const key = `${W}x${H}|${c}|${series.map(p => `${p.at}:${p.total}`).join(',')}`;
    if (wrap.dataset.key === key) return;
    wrap.dataset.key = key;
    hideTip(wrap);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!series.length) {
      svg.innerHTML = `<text class="none" x="${W / 2}" y="${H / 2}" text-anchor="middle">No games yet</text>`;
      charts.set(wrap, null);
      return;
    }
    const vals = [0, ...series.map(p => p.total)], lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    const PL = 6, PR = 10, PT = 16, PB = 20;
    const x = i => PL + (i / (vals.length - 1)) * (W - PL - PR), y = v => PT + ((hi - v) / span) * (H - PT - PB);
    const pts = vals.map((v, i) => [x(i), y(v)]), z = y(0), id = wrap.id, last = pts[pts.length - 1];
    const zOff = ((z - PT) / (H - PT - PB)).toFixed(3);
    const line = pts.map(([a, b], i) => `${i ? 'L' : 'M'}${f1(a)},${f1(b)}`).join('');
    const r = series.length > 40 ? 2.5 : 4;
    svg.innerHTML = `<defs>
      <linearGradient id="${id}-fill" gradientUnits="userSpaceOnUse" x1="0" y1="${PT}" x2="0" y2="${H - PB}">
        <stop offset="0" class="s-up" stop-opacity=".4"/><stop offset="${zOff}" class="s-up" stop-opacity="0"/>
        <stop offset="${zOff}" class="s-down" stop-opacity="0"/><stop offset="1" class="s-down" stop-opacity=".4"/>
      </linearGradient>
      <clipPath id="${id}-clip"><rect class="wipe" x="-10" y="-10" width="${W + 20}" height="${H + 20}"/></clipPath>
    </defs>
    <line class="zero" x1="0" x2="${W}" y1="${f1(z)}" y2="${f1(z)}"/>
    <line class="guide" x1="0" x2="0" y1="${PT}" y2="${H - PB}" visibility="hidden"/>
    <g clip-path="url(#${id}-clip)">
      <path d="${line}L${f1(last[0])},${f1(z)}L${f1(pts[0][0])},${f1(z)}Z" fill="url(#${id}-fill)"/>
      ${series.map((p, i) => `<path class="seg ${dir(p.net)}" d="M${f1(pts[i][0])},${f1(pts[i][1])}L${f1(pts[i + 1][0])},${f1(pts[i + 1][1])}"/>`).join('')}
      ${series.map((p, i) => `<circle class="dot ${dir(p.net)}" cx="${f1(pts[i + 1][0])}" cy="${f1(pts[i + 1][1])}" r="${r}"/>`).join('')}
    </g>
    ${hi > 0 ? `<text x="${PL}" y="${PT - 5}">${esc(signed(hi, c))}</text>` : ''}
    ${lo < 0 ? `<text x="${PL}" y="${H - 5}">${esc(signed(lo, c))}</text>` : ''}
    <text x="${W - PR}" y="${H - 5}" text-anchor="end">${esc(fmtDate(series[0].at))}${series.length > 1 ? ` – ${esc(fmtDate(series[series.length - 1].at))}` : ''}</text>`;
    charts.set(wrap, { W, PB, H, r, c, series, pts: pts.slice(1) });
  }
  function hideTip(wrap) {
    wrap.querySelector('.tip').hidden = true;
    wrap.querySelector('.guide')?.setAttribute('visibility', 'hidden');
    for (const d of wrap.querySelectorAll('.dot.on')) { d.classList.remove('on'); d.setAttribute('r', charts.get(wrap)?.r ?? 4); }
  }
  function chartPoint(e) {
    const wrap = e.currentTarget, d = charts.get(wrap);
    if (!d) return;
    const box = wrap.getBoundingClientRect(), px = (e.clientX - box.left) * (d.W / box.width);
    let i = 0;
    d.pts.forEach(([ptx], k) => { if (Math.abs(ptx - px) < Math.abs(d.pts[i][0] - px)) i = k; });
    hideTip(wrap);
    const [cx, cy] = d.pts[i], p = d.series[i], dot = wrap.querySelectorAll('.dot')[i], guide = wrap.querySelector('.guide');
    dot.classList.add('on');
    dot.setAttribute('r', d.r + 2.5);
    guide.setAttribute('x1', cx); guide.setAttribute('x2', cx); guide.setAttribute('visibility', 'visible');
    const tip = wrap.querySelector('.tip'), g = p.game || {};
    const line = (tag, text, cls = '') => Object.assign(document.createElement(tag), { textContent: text, className: cls });
    tip.replaceChildren(line('span', `${fmtDate(p.at)} · ${g.name || 'Home game'}`), line('b', signed(p.net, g.currency || d.c), dir(p.net)),
      line('span', `Total ${signed(p.total, d.c)}`, 'meta'));
    tip.hidden = false;
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(Math.max(cx, half), d.W - half)}px`;
    tip.style.top = `${cy}px`;
    tip.classList.toggle('below', cy < 64);
  }
  for (const w of document.querySelectorAll('.chart')) {
    w.addEventListener('pointermove', chartPoint);
    w.addEventListener('pointerdown', chartPoint);
    w.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hideTip(w); }); // on touch the tip stays until the next tap
  }

  // One bar per player from the zero line: green up, red down, the amount at the tip and the name underneath.
  function barChart(svg, results) {
    const W = Math.round(svg.clientWidth), H = Math.round(svg.clientHeight);
    if (!W) return;
    const key = `${W}x${H}|${results.map(r => `${r.name}:${r.net}`).join(',')}`;
    if (svg.dataset.key === key) return;
    svg.dataset.key = key;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const n = Math.max(1, results.length), PT = 18, PB = 34, slot = W / n, bw = Math.min(44, slot * 0.62);
    const vals = results.map(r => r.net), hi = Math.max(0, ...vals), lo = Math.min(0, ...vals), span = hi - lo || 1;
    const y = v => PT + ((hi - v) / span) * (H - PT - PB), z = y(0);
    const chars = Math.max(3, Math.floor(slot / 6.5)), short = t => (t.length > chars ? `${t.slice(0, chars - 1)}…` : t);
    // shortcut: amounts are left off when bars get narrower than ~36px (10+ players); the results card below still lists them.
    const showVals = slot >= 36;
    svg.innerHTML = results.map((r, i) => {
      const cx = slot * (i + 0.5), h = Math.max(2, Math.abs(y(r.net) - z)), d = dir(r.net);
      const top = d === 'down' ? z : d === 'up' ? z - h : z - 1;
      const vy = d === 'down' ? z + h + 13 : top - 5;
      return `<g><title>${esc(r.name)}: ${esc(L.fmtNet(r.net))}</title>
        <rect class="${d}" x="${f1(cx - bw / 2)}" y="${f1(top)}" width="${f1(bw)}" height="${f1(h)}" rx="${f1(Math.min(6, bw / 4))}" style="animation-delay:${i * 45}ms"/>
        ${showVals ? `<text class="val ${d}" x="${f1(cx)}" y="${f1(vy)}" text-anchor="middle">${esc(L.fmtNet(r.net))}</text>` : ''}
        <text x="${f1(cx)}" y="${H - 6}" text-anchor="middle">${esc(short(r.name))}</text></g>`;
    }).join('') + `<line class="zero" x1="0" x2="${W}" y1="${f1(z)}" y2="${f1(z)}"/>`;
  }

  // ---- Live dashboard: pot graph, facts, "who's in deepest" bar race, pot count-up and "+200 kr · Bo" pop ----
  // The pot over the game: a step up at every buy-in, an amber dot per rebuy, a pulsing dot at "now".
  function potChart(wrap, players, c, start) {
    const svg = wrap.querySelector('svg'), W = Math.round(wrap.clientWidth), H = Math.round(wrap.clientHeight);
    if (!W) return; // hidden: drawn when it shows
    const ev = L.potSeries(players), now = Date.now();
    const key = `${W}x${H}|${c}|${ev.map(e => `${e.at}:${e.total}`).join(',')}|${Math.floor(now / 60000)}`;
    if (wrap.dataset.key === key) return; // redrawn when money comes in, and once a minute so "now" moves
    wrap.dataset.key = key;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    if (!ev.length) { svg.innerHTML = ''; return; }
    const t0 = Math.min(start ?? Infinity, ev[0].at), t1 = Math.max(now, ev[ev.length - 1].at, t0 + 60000);
    const PL = 4, PR = 6, PT = 18, PB = 18, hi = ev[ev.length - 1].total || 1;
    const x = t => PL + ((t - t0) / (t1 - t0)) * (W - PL - PR), y = v => PT + (1 - v / hi) * (H - PT - PB);
    const line = `M${f1(x(t0))},${f1(y(0))}` + ev.map(e => `H${f1(x(e.at))}V${f1(y(e.total))}`).join('') + `H${f1(x(t1))}`;
    svg.innerHTML = `<defs><linearGradient id="${wrap.id}-g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" class="s-up" stop-opacity=".45"/><stop offset="1" class="s-up" stop-opacity="0"/></linearGradient></defs>
      <path d="${line}V${f1(y(0))}Z" fill="url(#${wrap.id}-g)"/><path class="pline" d="${line}"/>
      ${ev.filter(e => e.rebuy).map(e => `<circle class="pdot" cx="${f1(x(e.at))}" cy="${f1(y(e.total))}" r="3.5"><title>${esc(e.name)} +${esc(money(e.money, c))} · ${esc(fmtClockTime(e.at))}</title></circle>`).join('')}
      <circle class="pnow" cx="${f1(x(t1))}" cy="${f1(y(hi))}" r="4"/>
      <text x="${PL}" y="${PT - 5}">${esc(money(hi, c))}</text>
      <text x="${PL}" y="${H - 3}">${esc(fmtClockTime(t0))}</text><text x="${W - PR}" y="${H - 3}" text-anchor="end">now</text>`;
  }
  const ago = ms => { const m = Math.floor(ms / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`; };
  function renderFacts(el, players, c) {
    const f = L.liveFacts(players), now = Date.now(), items = [];
    if (f.king) items.push(['Rebuy king', `${f.king.name} · ${plural(f.king.rebuys, 'rebuy')}`]);
    if (f.deepest && players.length > 1) items.push(['Deepest in', `${f.deepest.name} · ${money(f.deepest.money, c)}`]);
    if (f.last) items.push(['Last rebuy', `${f.last.name} · ${ago(now - f.last.at)}`]);
    if (f.lastHour > 0) items.push(['Last hour', `+${money(f.lastHour, c)}`]);
    if (f.out) items.push(['Cashed out', `${f.out} of ${players.length}`]);
    el.replaceChildren(...items.map(([label, value]) => {
      const d = Object.assign(document.createElement('div'), { className: 'fact' });
      d.append(Object.assign(document.createElement('span'), { textContent: label }), Object.assign(document.createElement('b'), { textContent: value }));
      return d;
    }));
  }
  // Rows stay in place (keyed by name) and are sorted with CSS `order`, so the bars glide to their new length.
  function renderRace(ul, players, c) {
    const max = Math.max(1, ...players.map(p => L.money(p)));
    const rows = players.map((p, i) => ({ p, i, m: L.money(p) })).sort((a, b) => b.m - a.m || a.p.name.localeCompare(b.p.name, 'en'));
    const old = new Map([...ul.children].map(li => [li.dataset.key, li]));
    const keep = new Set(rows.map(r => lc(r.p.name)));
    for (const [key, li] of old) if (!keep.has(key)) li.remove();
    rows.forEach(({ p, i, m }, rank) => {
      const key = lc(p.name), out = p.count !== null;
      let li = old.get(key);
      const isNew = !li;
      if (isNew) { li = clone('tplRace'); li.dataset.key = key; }
      const b = li.querySelector('button'), bar = li.querySelector('.race-bar'), chips = li.querySelector('.race-chips');
      paint(li.querySelector('.avatar'), p.name);
      put(li, '.name', p.name);
      put(li, '.race-amt', out ? `out ${money(p.count, c)}` : money(m, c));
      const chip = (text, cls) => Object.assign(document.createElement('span'), { textContent: text, className: cls });
      chips.replaceChildren(...[
        state.dealer && lc(state.dealer) === lc(p.name) && chip('Dealer', 'dealer'),
        state.seated && chip(`Seat ${i + 1}`, 'seat-chip'),
        p.buys.length > 1 && chip(`×${p.buys.length}`, 'rb'),
        out && chip(signed(p.count - m, c), dir(p.count - m)),
      ].filter(Boolean));
      b.classList.toggle('cashed', out);
      b.dataset.i = i;
      b.setAttribute('aria-label', `${p.name}, in ${money(m, c)}${p.buys.length > 1 ? `, ${plural(p.buys.length - 1, 'rebuy')}` : ''}${out ? `, cashed out ${money(p.count, c)}` : ''}`);
      li.style.order = rank;
      const width = `${Math.max(3, (m / max) * 100).toFixed(1)}%`;
      if (isNew) { bar.style.width = '0%'; ul.append(li); requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = width; })); }
      else bar.style.width = width;
    });
  }
  // Money counts up to its new value instead of jumping.
  const shown = new WeakMap();
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  function countTo(el, to, c) {
    const from = shown.get(el);
    shown.set(el, to);
    cancelAnimationFrame(el._anim);
    if (from === undefined || from === to || reduceMotion.matches) { el.textContent = money(to, c); return; }
    const t0 = performance.now();
    const step = t => {
      const k = Math.min(1, (t - t0) / 700), e = 1 - (1 - k) ** 3;
      el.textContent = money(round(from + (to - from) * e), c);
      if (k < 1) el._anim = requestAnimationFrame(step);
    };
    el._anim = requestAnimationFrame(step);
  }
  // A "+200 kr · Bo" pop by the pot whenever a new buy-in lands (not on the first draw).
  let seenBuys = null, bumpTimer = null;
  function announce(players, c) {
    const n = players.reduce((s, p) => s + p.buys.length, 0);
    if (seenBuys !== null && n > seenBuys) {
      const e = L.potSeries(players).at(-1);
      for (const id of ['potBump', 'bigBump']) {
        const el = $(id);
        el.hidden = true;
        void el.offsetWidth; // restart the pop animation
        el.textContent = `+${money(e.money, c)} · ${e.name}`;
        el.hidden = false;
      }
      clearTimeout(bumpTimer);
      bumpTimer = setTimeout(() => { $('potBump').hidden = $('bigBump').hidden = true; }, 3000);
      const hero = document.querySelector('.live-hero');
      hero.classList.remove('flash');
      void hero.offsetWidth; // restart the glow
      hero.classList.add('flash');
    }
    seenBuys = n;
  }
  const renderDash = () => { // the parts that change with time even when nobody rebuys
    if (!running()) return;
    potChart($('potChart'), state.players, C(), state.startedAt);
    potChart($('bigChart'), state.players, C(), state.startedAt);
    renderFacts($('liveFacts'), state.players, C());
    renderFacts($('bigFacts'), state.players, C());
  };

  // ---- Stats tab ----
  function renderStats() {
    const period = $('statPeriod').value, c = totalsCur();
    const since = period === 'ytd' ? new Date(new Date().getFullYear(), 0, 1).getTime() : period === '30' ? Date.now() - 30 * 864e5 : 0;
    const hist = games.filter(g => g.endedAt >= since);
    const names = L.leaderboard(games).map(r => r.name);
    if (statWho && !names.some(n => lc(n) === lc(statWho))) statWho = '';
    const sel = $('statWho');
    if (document.activeElement !== sel) {
      sel.replaceChildren(new Option('All players', ''), ...names.map(n => new Option(n, n)));
      sel.value = names.find(n => lc(n) === lc(statWho)) || '';
    }
    $('statsEmpty').hidden = hist.length > 0;
    $('statPlayer').hidden = !statWho || !hist.length;
    $('statAll').hidden = !!statWho || !hist.length;
    if (!hist.length) return;
    if (statWho) {
      const s = L.playerStats(games, statWho, since);
      $('stNet').textContent = signed(s.net, c);
      tone($('stNet'), s.net);
      $('stSessions').textContent = s.sessions;
      $('stHourly').textContent = signed(Math.round(s.hourly), c); // whole numbers read better for averages
      $('stTime').textContent = fmtDur(s.timeMs);
      $('stAvgWin').textContent = money(Math.round(s.avgWin), c);
      $('stAvgLoss').textContent = signed(Math.round(s.avgLoss), c);
      $('stAvgLen').textContent = fmtDur(s.avgSessionMs);
      $('stWinRate').textContent = `${(s.winRate * 100).toFixed(1)}%`;
      $('stWinSub').textContent = `${s.wins} / ${s.sessions} · session win rate`;
      lineChart($('stChart'), s.series, c);
      return;
    }
    const pots = hist.map(g => cents(g.pot));
    $('saSessions').textContent = hist.length;
    $('saPots').textContent = money(pots.reduce((a, b) => a + b, 0) / 100, c);
    $('saAvgPot').textContent = money(Math.round(pots.reduce((a, b) => a + b, 0) / hist.length / 100), c);
    $('saBiggest').textContent = money(Math.max(...pots) / 100, c);
    $('saTime').textContent = fmtDur(hist.reduce((s, g) => s + g.duration, 0));
    $('saPlayers').textContent = new Set(hist.flatMap(g => g.results.map(r => lc(r.name)))).size;
    $('leaderboard').replaceChildren(...L.leaderboard(hist).map((r, i) => {
      const li = clone('tplBoard'), btn = li.querySelector('button'), st = li.querySelector('.streak'), net = li.querySelector('.net');
      put(li, '.rank', i + 1);
      paint(li.querySelector('.avatar'), r.name);
      put(li, '.name', r.name);
      put(li, '.meta', `${plural(r.games, 'game')} · ${plural(r.wins, 'win')}${r.bestStreak ? ` · best run W${r.bestStreak}` : ''}`);
      streakTag(st, r);
      net.textContent = signed(r.net, c);
      tone(net, r.net);
      btn.dataset.name = r.name;
      return li;
    }));
  }

  // ---- Profile tab ----
  function renderProfile() {
    const names = [...profileList().map(p => p.name), ...L.leaderboard(games).map(r => r.name).filter(n => !savedName(n))];
    const sel = $('prefMe');
    if (document.activeElement !== sel) {
      sel.replaceChildren(new Option('Not set', ''), ...names.map(n => new Option(n, n)));
      sel.value = prefs.me && names.includes(prefs.me) ? prefs.me : '';
    }
    const me = prefs.me;
    paint($('meAvatar'), me);
    $('meName').textContent = me || 'Pick yourself';
    if (me) {
      const st = L.playerStats(games, me);
      $('meSub').textContent = `${plural(st.sessions, 'game')} · ${signed(st.net, totalsCur())} all time`;
    } else $('meSub').textContent = 'Choose who you are to see your own results on Home';
    $('prefCur').value = prefs.currency;
    setVal($('prefBuyIn'), prefs.buyIn);
    $('accEmail').textContent = account;
    const linkable = !!(ON && host && !me && onlinePlayers);
    $('linkCard').hidden = !linkable;
    if (linkable && document.activeElement !== $('linkWho')) {
      const free = onlinePlayers.filter(p => p.id && !p.user_id);
      $('linkWho').replaceChildren(new Option(free.length ? 'Pick your name' : 'Add yourself on the Leaderboard tab first', ''), ...free.map(p => new Option(p.name, p.id)));
    }
    $('profHint').textContent = ON ? 'Saved online. Everyone in the group sees the same games and leaderboard.'
      : 'Everything is saved in this browser on this laptop.';
  }

  // ---- Player page ----
  function renderPerson() {
    if (!person) return;
    const c = totalsCur(), s = L.playerStats(games, person), has = s.sessions > 0;
    const show = (id, v, rounded = false) => { const el = $(id), n = rounded ? Math.round(v) : v; el.textContent = signed(n, c); tone(el, has ? n : null); };
    paint($('personAvatar'), person);
    $('personName').textContent = person;
    $('personSub').textContent = has ? `Since ${fmtDate(s.series[0].at)}` : 'No games yet';
    $('personMeta').textContent = has ? `${plural(s.sessions, 'game')} · ${fmtDur(s.timeMs)} at the table` : 'Their games show up here once one is finished';
    show('pNet', s.net);
    $('pGames').textContent = s.sessions;
    $('pWins').textContent = s.wins;
    $('pRate').textContent = `${Math.round(s.winRate * 100)}%`;
    show('pBest', s.biggestWin);
    show('pWorst', s.worstLoss);
    $('pStreak').textContent = plural(s.bestStreak, 'win');
    show('pAvg', s.avgNet, true);
    show('pHourly', s.hourly, true); // whole numbers read better for averages
    $('pTime').textContent = fmtDur(s.timeMs);
    lineChart($('pChart'), s.series, c);
    $('pGameList').replaceChildren(...s.series.slice().reverse().map(p => {
      const g = p.game, li = clone('tplGameRow'), d = new Date(p.at), net = li.querySelector('.net');
      put(li, '.when b', d.getDate());
      put(li, '.when small', d.toLocaleDateString('en-US', { month: 'short' }));
      put(li, '.name', g.name || 'Home game');
      put(li, '.meta', `${d.getFullYear()} · ${plural(g.results.length, 'player')} · pot ${money(g.pot, g.currency)}`);
      net.textContent = signed(p.net, g.currency);
      tone(net, p.net);
      li.querySelector('button').addEventListener('click', () => openGame(g));
      return li;
    }));
    $('pEmpty').hidden = has;
    renderBadges(person, has);
    renderH2h(has);
  }
  let h2hWho = '';
  function renderH2h(has) {
    const others = L.leaderboard(games).map(r => r.name).filter(n => lc(n) !== lc(person));
    $('h2h').hidden = !has || !others.length;
    if ($('h2h').hidden) return;
    if (!others.some(n => lc(n) === lc(h2hWho))) {
      h2hWho = (prefs.me && lc(prefs.me) !== lc(person) && others.find(n => lc(n) === lc(prefs.me))) || others[0];
    }
    const sel = $('h2hWho');
    if (document.activeElement !== sel) { sel.replaceChildren(...others.map(n => new Option(`vs ${n}`, n))); sel.value = h2hWho; }
    const h = L.headToHead(games, person, h2hWho), c = totalsCur(), el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || '', textContent: text });
    if (!h.games) { $('h2hBody').replaceChildren(el('p', 'hint', `${person} and ${h2hWho} haven't played a game together yet.`)); return; }
    const side = (name, n, net) => { const d = el('div', ''); const b = el('b', '', String(n)); d.append(el('span', '', name), b, el('span', dir(net), signed(net, c))); return d; };
    const row = el('div', 'h2h-row');
    row.append(side(person, h.aAhead, h.aNet), el('span', '', `${plural(h.games, 'game')} together${h.even ? ` · ${h.even} even` : ''}`), side(h2hWho, h.bAhead, h.bNet));
    const bar = el('div', 'h2h-bar'), tot = Math.max(1, h.aAhead + h.bAhead);
    const seg = (cls, n) => { const i = el('i', cls); i.style.width = `${(n / tot) * 100}%`; return i; };
    bar.append(seg('a', h.aAhead), seg('b', h.bAhead));
    $('h2hBody').replaceChildren(row, bar, el('p', 'hint', 'Games where each finished ahead of the other, and their total over those games.'));
  }

  // ---- New game ----
  function renderSetup() {
    if (state.phase !== 'setup') return;
    const c = C();
    $('setupBuyIn').textContent = L.fmtMoney(state.buyIn);
    setVal($('gameName'), state.name);
    $('setupCur').value = state.currency;
    $('setupBomb').value = String(state.bombEvery);
    $('setupPractice').checked = !!state.practice;
    $('setupCount').textContent = state.players.length;
    $('setupSeats').hidden = state.players.length < 2;
    $('setupSeats').textContent = state.seated ? 'Draw seats again' : 'Draw seats and dealer';
    $('setupPlayers').replaceChildren(...state.players.map((p, i) => {
      const li = clone('tplSetupRow'), amt = li.querySelector('[data-act="amount"]'), rm = li.querySelector('[data-act="remove"]');
      paint(li.querySelector('.avatar'), p.name);
      put(li, '.name', p.name);
      put(li, '.seat', state.seated ? `Seat ${i + 1}${state.dealer && lc(state.dealer) === lc(p.name) ? ' · Dealer' : ''}` : '');
      amt.textContent = money(L.money(p), c);
      amt.dataset.i = rm.dataset.i = i;
      amt.setAttribute('aria-label', `Change ${p.name}'s buy-in`);
      rm.setAttribute('aria-label', `Remove ${p.name}`);
      return li;
    }));
    $('setupEmpty').hidden = state.players.length > 0;
    $('startGame').disabled = state.players.length < 2;
  }

  // ---- Live game ----
  function txList() {
    const out = [];
    state.players.forEach((p, i) => {
      p.buys.forEach((b, j) => out.push({ p, i, j, kind: j ? 'rebuy' : 'buy-in', money: b.money, at: b.at }));
      if (p.count !== null) out.push({ p, i, j: -1, kind: 'cash out', money: p.count, at: p.outAt });
    });
    return out.sort((a, b) => b.at - a.at);
  }
  function renderLive() {
    if (!running()) { seenBuys = null; return; } // live, or (for friends watching) being set up
    const P = state.players, c = C(), f = L.liveFacts(P);
    $('liveName').textContent = state.name || 'Home game';
    $('liveSub').textContent = `${state.practice ? 'Practice · ' : ''}${plural(P.length, 'player')}`;
    countTo($('stIn'), L.totals(P).money, c);
    $('stPlay').textContent = money(inPlay(), c);
    $('stRebuys').textContent = f.rebuys;
    $('stAvg').textContent = money(Math.round(f.avg), c);
    $('clockLabel').textContent = state.phase === 'setup' ? 'Not started' : state.since ? 'Duration' : 'Paused';
    $('liveCount').textContent = P.length;
    renderRace($('liveAvatars'), P, c);
    announce(P, c);
    renderDash();
    if (actFilter && !findPlayer(actFilter)) actFilter = null;
    $('actFilter').replaceChildren(...[null, ...P.map(p => p.name)].map(n => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'filter', textContent: n ?? 'All' });
      b.dataset.name = n ?? '';
      b.setAttribute('aria-pressed', String(n === actFilter));
      return b;
    }));
    const txs = txList().filter(x => !actFilter || x.p.name === actFilter);
    $('activity').replaceChildren(...txs.map(x => {
      const li = clone('tplTx'), b = li.querySelector('button'), tag = li.querySelector('.tag');
      put(li, '.tx-amt', money(x.money, c));
      put(li, '.tx-name', x.p.name);
      put(li, '.tx-time', fmtClockTime(x.at));
      tag.textContent = x.kind;
      tag.classList.add(x.kind === 'cash out' ? 'out' : x.kind === 'buy-in' ? 'buyin' : 'rebuy');
      b.dataset.i = x.i;
      b.dataset.j = x.j;
      return li;
    }));
    const allOut = P.length > 0 && P.every(p => p.count !== null);
    $('finishBox').hidden = !allOut;
    if (allOut) {
      const co = L.cashOut(P);
      $('finishText').textContent = co.ok ? 'Everyone has cashed out and it adds up.'
        : `Everyone has cashed out, but the cash-outs are ${money(Math.abs(co.diff), c)} ${co.diff < 0 ? 'short of' : 'more than'} the buy-ins. Tap a transaction to fix it.`;
      $('finishGame').disabled = !co.ok || saving;
    }
  }

  // ---- Awards (one game) and badges (a player's career) ----
  const AWARDS = {
    shark: ['🦈', 'Shark of the night', (v, c) => signed(v, c), 'up'],
    generous: ['🎁', 'Most generous', (v, c) => signed(v, c), 'down'],
    rebuyKing: ['👑', 'Rebuy king', v => plural(v, 'rebuy'), ''],
    comeback: ['🔥', 'Comeback kid', (v, c) => `${signed(v, c)} after rebuys`, 'up'],
    ironman: ['🪑', 'Iron man', v => `${fmtDur(v)} at the table`, ''],
    evenSteven: ['⚖️', 'Even Steven', () => 'Broke exactly even', 'even'],
  };
  const BADGES = {
    firstGame: ['🃏', 'First game', () => 'Sat down for a game'],
    firstWin: ['🏆', 'First win', () => 'Won a game'],
    hatTrick: ['🎩', 'Hat trick', () => '3 wins in a row'],
    bigNight: ['💰', 'Big night', c => `Won ${money(1000, c)}+ in a game`],
    fiveWins: ['🖐️', 'Five wins', () => 'Won 5 games'],
    regular: ['📅', 'Regular', () => 'Played 10 games'],
    veteran: ['🎖️', 'Veteran', () => 'Played 25 games'],
    inTheGreen: ['📈', 'In the green', () => 'Up overall after 5+ games'],
    comeback: ['🔥', 'Comeback', () => 'Won after 2+ rebuys'],
    marathon: ['⏱️', 'Marathon', () => '5+ hours in one game'],
  };
  // The award cards for one game, then any badge a player earned in it (not "First game": everyone gets that one).
  function awardItems(r) {
    const c = r.currency;
    const items = L.awards(r).map(a => {
      const [ico, title, fmt, cls] = AWARDS[a.key];
      return { ico, title, name: a.name, val: fmt(a.value, c), cls, dup: a.key === 'shark' || a.key === 'generous' };
    });
    if (r.id && !r.practice) {
      for (const x of r.results) {
        for (const b of L.achievements(games, x.name)) {
          if (b.at !== r.endedAt || b.key === 'firstGame') continue;
          const [ico, title, desc] = BADGES[b.key];
          items.push({ ico, title: `New badge · ${title}`, name: x.name, val: desc(c), cls: '', fresh: true });
        }
      }
    }
    return items;
  }
  function renderAwards(el, items) {
    el.replaceChildren(...items.map(a => {
      const d = clone('tplAward'), v = d.querySelector('.aw-val');
      put(d, '.aw-ico', a.ico);
      put(d, '.aw-title', a.title);
      put(d, '.name', a.name);
      v.textContent = a.val;
      if (a.cls) v.classList.add(a.cls);
      d.classList.toggle('badge-new', !!a.fresh);
      return d;
    }));
    el.hidden = !items.length;
  }
  function renderBadges(name, has) {
    $('badgeCard').hidden = !has;
    if (!has) return;
    const list = L.achievements(games, name), c = totalsCur();
    $('badgeCount').textContent = `${list.filter(b => b.earned).length} of ${list.length}`;
    $('badges').replaceChildren(...list.map(b => {
      const [ico, title, desc] = BADGES[b.key], li = clone('tplBadge');
      put(li, '.b-ico', ico);
      put(li, 'b', title);
      put(li, 'span:last-child', b.earned ? `${desc(c)} · ${new Date(b.at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}` : desc(c));
      li.classList.toggle('locked', !b.earned);
      li.setAttribute('aria-label', `${title}: ${desc(c)}${b.earned ? '' : ' (not yet)'}`);
      return li;
    }));
  }

  // ---- Results ----
  const shownRecord = () => viewing || (state.phase === 'done' ? state.result : null);
  function renderResults() {
    const r = shownRecord();
    if (!r) return;
    const c = r.currency, st = L.gameStats(r);
    $('resTitle').textContent = r.name || 'Home game';
    $('resSub').textContent = fmtDate(r.startedAt ?? r.endedAt);
    $('dPot').textContent = money(st.pot, c);
    $('dPlayers').textContent = st.players;
    $('dDur').textContent = fmtDur(st.duration);
    $('dRebuys').textContent = st.rebuys ?? '–';
    $('dRebuys').title = st.rebuys === null ? 'Not recorded for older games' : '';
    for (const [who, av, nameId, netId] of [[st.winner, 'dWinAv', 'dWin', 'dWinNet'], [st.loser, 'dLoseAv', 'dLose', 'dLoseNet']]) {
      paint($(av), who?.name, '–');
      $(nameId).textContent = who ? who.name : 'Nobody';
      $(netId).textContent = who ? signed(who.net, c) : money(0, c);
    }
    renderAwards($('awards'), awardItems(r).filter(a => !a.dup)); // shark and generous are the winner/loser tiles above
    $('dCur').textContent = c === 'CHIPS' ? '· chips' : `· ${c}`;
    barChart($('dBars'), r.results);
    $('rcName').textContent = r.name || 'Home game';
    $('rcDur').textContent = fmtDur(r.duration);
    $('rcPlayers').replaceChildren(...r.results.map(x => {
      const li = clone('tplRc'), n = li.querySelector('.net');
      put(li, '.name', x.name);
      n.textContent = signed(x.net, c);
      tone(n, x.net);
      return li;
    }));
    $('rcSettle').replaceChildren(...r.transfers.map((t, i) => {
      const li = clone('tplSettle'), b = li.querySelector('.paid');
      put(li, '.from', t.from);
      put(li, '.to', t.to);
      put(li, '.amount', money(t.amount, c));
      li.dataset.i = i;
      li.classList.toggle('settled', !!t.paid);
      b.hidden = !r.id || (!host && !t.paid); // saved games only; friends just see what's paid
      b.disabled = !host;
      b.textContent = t.paid ? '✓ Paid' : 'Mark paid';
      b.classList.toggle('on', !!t.paid);
      return li;
    }));
    $('rcSettleEmpty').hidden = r.transfers.length > 0;
    const paid = r.transfers.filter(t => t.paid).length;
    $('rcPaid').textContent = r.id && r.transfers.length ? `· ${paid} of ${r.transfers.length} paid` : '';
    $('resPractice').hidden = !r.practice;
    $('resDelete').hidden = !r.id;
    $('rcDate').textContent = fmtDate(r.endedAt);
    $('resDone').textContent = viewing ? 'Back' : 'Done';
  }
  const resultText = r => [
    `${r.name || 'Home game'} · ${fmtDate(r.endedAt)} · ${fmtDur(r.duration)}`, '',
    ...r.results.map(x => `${x.name}: ${signed(x.net, r.currency)}`), '', 'Settlements:',
    ...(r.transfers.length ? r.transfers.map(t => `${t.from} → ${t.to}: ${money(t.amount, r.currency)}`) : ['All square']),
  ].join('\n');
  // Results as a PNG. On a phone it opens the share sheet (straight into the group chat); on a laptop it downloads.
  function saveImage(r) {
    const W = 720, row = 46, css = getComputedStyle(document.documentElement), col = n => css.getPropertyValue(n).trim();
    const aw = L.awards(r);
    const H = 170 + r.results.length * row + (aw.length ? 30 + row + aw.length * row : 0) + 90 + Math.max(1, r.transfers.length) * row + 70;
    const cv = document.createElement('canvas');
    cv.width = W * 2; cv.height = H * 2;
    const x = cv.getContext('2d');
    x.scale(2, 2);
    x.fillStyle = col('--bg'); x.fillRect(0, 0, W, H);
    x.beginPath(); x.roundRect(20, 20, W - 40, H - 40, 28);
    x.fillStyle = col('--surface'); x.fill();
    x.lineWidth = 3; x.strokeStyle = col('--line-strong'); x.stroke();
    const text = (s, px, weight, color, tx, ty, align = 'left') => {
      x.font = `${weight} ${px}px Nunito, ui-rounded, sans-serif`; x.fillStyle = color; x.textAlign = align; x.fillText(s, tx, ty);
    };
    text(r.name || 'Home game', 34, 900, col('--text'), 56, 92);
    text(fmtDur(r.duration), 22, 700, col('--muted'), W - 56, 92, 'right');
    let y = 160;
    for (const res of r.results) {
      text(res.name, 26, 800, col('--text'), 56, y);
      text(signed(res.net, r.currency), 26, 900, col(res.net > 0 ? '--green' : res.net < 0 ? '--red' : '--muted'), W - 56, y, 'right');
      y += row;
    }
    if (aw.length) {
      y += 30;
      text('Awards', 20, 700, col('--muted'), 56, y);
      y += row;
      for (const a of aw) {
        const [ico, title, fmt] = AWARDS[a.key];
        text(`${ico}  ${title}`, 22, 800, col('--text'), 56, y);
        text(`${a.name} · ${fmt(a.value, r.currency)}`, 22, 800, col('--muted'), W - 56, y, 'right');
        y += row;
      }
    }
    y += 30;
    text('Settlements', 20, 700, col('--muted'), 56, y);
    y += row;
    for (const t of r.transfers.length ? r.transfers : [null]) {
      if (t) { text(`${t.from} → ${t.to}`, 24, 800, col('--text'), 56, y); text(money(t.amount, r.currency), 24, 900, col('--text'), W - 56, y, 'right'); }
      else text('All square. Nobody owes anything.', 22, 700, col('--muted'), 56, y);
      y += row;
    }
    text(fmtDate(r.endedAt), 18, 700, col('--muted'), 56, H - 52);
    text('Kongens Nytorv Home Games', 18, 700, col('--muted'), W - 56, H - 52, 'right');
    // Made synchronously (toDataURL, not toBlob): phones only allow the share sheet right after the tap.
    let blob;
    try { blob = new Blob([Uint8Array.from(atob(cv.toDataURL('image/png').split(',')[1]), ch => ch.charCodeAt(0))], { type: 'image/png' }); }
    catch { flash("Couldn't make the image"); return; }
    const fileName = `${(r.name || 'home-game').replace(/[^\w-]+/g, '-')}-${new Date(r.endedAt).toISOString().slice(0, 10)}.png`;
    const download = () => {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: fileName });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      flash('Image saved to Downloads');
    };
    const file = typeof File === 'function' ? new File([blob], fileName, { type: 'image/png' }) : null;
    if (!file || !matchMedia('(pointer: coarse)').matches || !navigator.canShare?.({ files: [file] })) { download(); return; }
    navigator.share({ files: [file], title: r.name || 'Home game' }).catch(err => { if (err?.name !== 'AbortError') download(); });
  }

  // ---- Table screen ----
  function renderTable() {
    const P = state.players, r = state.phase === 'done' ? state.result : null, c = C();
    $('tablePhase').textContent = { none: 'Waiting for the game', setup: 'Players taking seats', live: state.since ? 'Game in progress' : 'Paused', done: 'Final results' }[state.phase];
    countTo($('bigPot'), L.totals(P).money, c);
    $('bigPlay').textContent = money(inPlay(), c);
    $('bigPlayers').textContent = P.length;
    $('tableDone').hidden = !r;
    $('tablePlayers').hidden = !!r;
    $('bigChart').parentElement.hidden = $('bigFacts').hidden = state.phase !== 'live';
    renderRace($('tablePlayers'), P, c);
    renderTvInvite();
    if (!r) return;
    $('tableResults').replaceChildren(...r.results.map(x => {
      const li = clone('tplRc'), n = li.querySelector('.net');
      put(li, '.name', x.name);
      n.textContent = signed(x.net, r.currency);
      tone(n, x.net);
      return li;
    }));
    const aw = awardItems(r);
    renderAwards($('tableAwards'), aw);
    $('tableAwardsCol').hidden = !aw.length;
    $('tableTransfers').replaceChildren(...r.transfers.map(t => {
      const li = clone('tplSettle');
      put(li, '.from', t.from);
      put(li, '.to', t.to);
      put(li, '.amount', money(t.amount, r.currency));
      return li;
    }));
  }

  let tvInvite = { key: null, url: null };
  function renderTvInvite() {
    const key = ON && host && running() ? String(state.startedAt ?? 'setup') : null;
    if (!key) tvInvite = { key: null, url: null };
    else if (key !== tvInvite.key) {
      tvInvite = { key, url: null };
      inviteLink().then(url => { if (tvInvite.key === key && url) { tvInvite.url = url; drawQr($('bigQr'), url); renderTvInvite(); } });
    }
    $('bigInvite').hidden = !(key && tvInvite.url);
  }

  // ---- Keypad sheet: one for every amount (buy-in, rebuy, cash out, edits). Laptop keys work too. ----
  let pad = null;
  const disarmPadDelete = twoTap($('padDelete'), 'Tap again to confirm', () => { const cb = pad?.onDelete; closePad(); cb?.(); });
  function openPad({ title, who = '', value = '', color = 'green', confirm = 'Confirm', hint = '', onConfirm, onDelete = null, deleteText = 'Delete', table = null }) {
    pad = { str: value === '' || value === null ? '' : String(value), fresh: true, onConfirm, onDelete };
    disarmPadDelete();
    $('padTitle').textContent = title;
    $('padWho').textContent = who;
    $('padWho').hidden = !who;
    $('padHint').textContent = hint;
    $('padValue').className = `huge ${color}`;
    $('padConfirm').className = `btn wide ${color === 'pink' ? 'purple' : 'primary'}`;
    $('padConfirm').textContent = confirm;
    $('padDelete').hidden = !onDelete;
    $('padDelete').textContent = deleteText;
    $('padError').hidden = true;
    const ul = $('padTable');
    ul.hidden = !table;
    if (table) {
      ul.replaceChildren(...state.players.map(p => {
        const li = clone('tplPadRow');
        put(li, '.name', p.name);
        put(li, '.meta', `in ${money(L.money(p), C())}`);
        put(li, '.out', p.count === null ? '–' : money(p.count, C()));
        if (p === table) li.setAttribute('aria-current', 'true');
        return li;
      }));
    }
    showPadValue();
    if (!$('pad').open) $('pad').showModal();
  }
  const showPadValue = () => { $('padValue').textContent = pad.str || '0'; };
  const closePad = () => { pad = null; if ($('pad').open) $('pad').close(); };
  function padKey(k) {
    if (!pad) return;
    if (k === 'back') pad.str = pad.fresh ? '' : pad.str.slice(0, -1);
    else {
      let s = pad.fresh ? '' : pad.str;
      if (k === '.') { if (!s.includes('.')) s = (s || '0') + '.'; }
      else if (/^\d$/.test(k) && !/\.\d\d$/.test(s) && s.replace('.', '').length < 9) s = s === '0' ? k : s + k;
      pad.str = s;
    }
    pad.fresh = false;
    $('padError').hidden = true;
    showPadValue();
  }
  function padConfirm() {
    if (!pad) return;
    const cb = pad.onConfirm, err = cb(pad.str === '' ? NaN : +pad.str);
    if (typeof err === 'string') { $('padError').textContent = err; $('padError').hidden = false; return; }
    if (pad && pad.onConfirm === cb) closePad(); // unless the callback opened the next amount
  }
  $('padKeys').addEventListener('click', e => { const b = e.target.closest('button[data-key]'); if (b) padKey(b.dataset.key); });
  $('padConfirm').addEventListener('click', padConfirm);
  $('padBack').addEventListener('click', closePad);
  $('pad').addEventListener('close', () => { pad = null; });
  document.addEventListener('keydown', e => {
    if (!$('pad').open || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (/^\d$/.test(k) || k === '.' || k === ',') { e.preventDefault(); padKey(k === ',' ? '.' : k); }
    else if (k === 'Backspace') { e.preventDefault(); padKey('back'); }
    else if (k === 'Enter') { e.preventDefault(); padConfirm(); }
  });

  // ---- money actions ----
  // The keypad finds the player again when you confirm: the game may have changed on another host device
  // while it was open, and an amount added to the old copy would be lost.
  const gone = name => `${name} isn't in the game any more (it changed on another device)`;
  function rebuy(p) {
    if (p.count !== null) { flash(`${p.name} has cashed out. Delete the cash out first.`); return; }
    const name = p.name;
    openPad({
      title: 'Rebuy', who: name, value: p.buys.at(-1).money, confirm: 'Add rebuy',
      onConfirm: v => {
        if (!(v > 0)) return 'Type an amount above 0';
        const q = findPlayer(name);
        if (!q) return gone(name);
        if (q.count !== null) return `${name} has cashed out. Delete the cash out first.`;
        const snap = snapshot();
        q.buys.push({ money: round(v), at: Date.now() });
        commit();
        offerUndo(snap, `${name} rebought for ${money(v, C())}`);
      },
    });
  }
  function cashOut(p, sequence = false) {
    const left = state.players.filter(q => q.count === null).length, name = p.name;
    openPad({
      title: sequence ? `Cash out · ${plural(left, 'player')} left` : 'Cash out', who: `${name} · in ${money(L.money(p), C())}`,
      value: p.count ?? '', color: 'pink', hint: 'Chips in front of them', table: p,
      onConfirm: v => {
        if (!(v >= 0)) return 'Type how much they have (0 if nothing)';
        const q = findPlayer(name);
        if (!q) return gone(name);
        const snap = snapshot();
        q.count = round(v);
        q.outAt = Date.now();
        if (state.players.every(x => x.count !== null)) pause();
        commit();
        offerUndo(snap, `${name} cashed out ${money(v, C())}`);
        const next = sequence && state.players.find(x => x.count === null);
        if (next) cashOut(next, true);
      },
    });
  }
  function editTx(i, j) {
    if (!host) return;
    const p = state.players[i];
    if (!p) return;
    const name = p.name;
    if (j < 0) {
      const out = () => { const q = findPlayer(name); return q && q.count !== null ? q : null; };
      openPad({
        title: 'Edit cash out', who: name, value: p.count, color: 'pink', table: p,
        onConfirm: v => {
          if (!(v >= 0)) return 'Type how much they have (0 if nothing)';
          const q = out();
          if (!q) return 'That cash out changed on another device';
          const snap = snapshot();
          q.count = round(v);
          commit();
          offerUndo(snap, `${name}'s cash out changed`);
        },
        onDelete: () => {
          const q = out();
          if (!q) { flash('That cash out changed on another device'); return; }
          const snap = snapshot();
          q.count = null; q.outAt = null;
          if (!state.since) state.since = Date.now();
          commit();
          offerUndo(snap, `${name} is back in the game`);
        },
        deleteText: 'Delete cash out (back in the game)',
      });
      return;
    }
    const b = p.buys[j];
    if (!b) return;
    const at = b.at, entry = () => { const q = findPlayer(name), k = q ? q.buys.findIndex(x => x.at === at) : -1; return k < 0 ? null : [q, k]; };
    const changed = 'That entry changed on another device';
    openPad({
      title: j ? 'Edit rebuy' : 'Edit buy-in', who: name, value: b.money,
      onConfirm: v => {
        if (!(v > 0)) return 'Type an amount above 0';
        const e = entry();
        if (!e) return changed;
        const snap = snapshot();
        e[0].buys[e[1]].money = round(v);
        commit();
        offerUndo(snap, `${name}'s ${j ? 'rebuy' : 'buy-in'} changed`);
      },
      onDelete: () => {
        const e = entry();
        if (!e) { flash(changed); return; }
        const [q, k] = e, snap = snapshot(), last = q.buys.length === 1;
        q.buys.splice(k, 1);
        if (last) state.players.splice(state.players.indexOf(q), 1);
        commit();
        offerUndo(snap, last ? `${name} removed` : `${name}'s rebuy deleted`);
      },
      deleteText: p.buys.length === 1 ? `Remove ${name} from the game` : 'Delete this rebuy',
    });
  }

  // ---- Add players sheet (setup: add many; live: add one, then their buy-in) ----
  let addMode = 'setup';
  const addErr = msg => { $('addError').textContent = msg; $('addError').hidden = !msg; };
  function renderAddChips() {
    const avail = profileList().filter(p => !findPlayer(p.name));
    $('addChips').replaceChildren(...avail.map(p => {
      const li = clone('tplChip'), add = li.querySelector('[data-act="add"]'), forget = li.querySelector('[data-act="forget"]');
      add.textContent = `+ ${p.name}${p.account ? ' ✓' : ''}`;
      forget.hidden = !!p.account;
      add.dataset.name = forget.dataset.name = p.name;
      add.setAttribute('aria-label', `Add ${p.name}`);
      forget.setAttribute('aria-label', `Forget ${p.name}`);
      return li;
    }));
    $('addChipsBox').hidden = !avail.length;
    $('profileList').replaceChildren(...profileList().map(p => new Option(p.name, p.name)));
  }
  function openAdd(mode) {
    if (!host) return;
    addMode = mode;
    $('addTitle').textContent = mode === 'setup' ? 'Add players' : 'Add a player';
    $('addDone').hidden = mode !== 'setup';
    $('addName').value = '';
    addErr('');
    renderAddChips();
    $('addSheet').showModal();
    $('addName').focus();
  }
  function addByName(raw) {
    const typed = raw.trim();
    if (!typed) return;
    const dup = findPlayer(typed);
    if (dup) { addErr(`${dup.name} is already in the game`); return; }
    const name = savedName(typed) || typed;
    remember(name);
    addErr('');
    if (addMode === 'setup') {
      state.players.push({ name, buys: [{ money: state.buyIn, at: Date.now() }], count: null, outAt: null });
      $('addName').value = '';
      commit();
      renderAddChips();
      $('addName').focus();
      return;
    }
    $('addSheet').close();
    openPad({
      title: 'Buy-in', who: name, value: state.buyIn, confirm: 'Add player',
      onConfirm: v => {
        if (!(v > 0)) return 'Type an amount above 0';
        if (findPlayer(name)) return `${name} is already in the game`;
        const snap = snapshot();
        state.players.push({ name, buys: [{ money: round(v), at: Date.now() }], count: null, outAt: null });
        commit();
        offerUndo(snap, `${name} joined with ${money(v, C())}`);
      },
    });
  }
  $('addForm').addEventListener('submit', e => { e.preventDefault(); addByName($('addName').value); });
  $('addChips').addEventListener('click', e => {
    const b = e.target.closest('button[data-name]');
    if (!b) return;
    if (b.dataset.act === 'forget') { forgetProfile(b.dataset.name); renderAddChips(); render(); }
    else addByName(b.dataset.name);
  });
  $('addClose').addEventListener('click', () => $('addSheet').close());
  $('addDone').addEventListener('click', () => $('addSheet').close());

  // ---- Player sheet and picker ----
  let psName = '';
  function openPlayer(i) {
    if (!host) return;
    const p = state.players[i];
    if (!p) return;
    psName = p.name;
    paint($('psAvatar'), p.name);
    $('psName').textContent = p.name;
    $('psMeta').textContent = `In ${money(L.money(p), C())} · ${plural(p.buys.length, 'buy-in')}` +
      (p.count === null ? '' : ` · cashed out ${money(p.count, C())}`);
    $('psCash').textContent = p.count === null ? 'Cash out' : 'Change cash out';
    $('psRebuy').disabled = p.count !== null;
    $('playerSheet').showModal();
  }
  $('psClose').addEventListener('click', () => $('playerSheet').close());
  $('psRebuy').addEventListener('click', () => { $('playerSheet').close(); const p = findPlayer(psName); if (p) rebuy(p); });
  $('psCash').addEventListener('click', () => { $('playerSheet').close(); const p = findPlayer(psName); if (p) cashOut(p); });

  let pickMode = 'rebuy';
  function openPick(mode) {
    if (!host) return;
    const list = state.players.filter(p => p.count === null);
    if (!list.length) { flash('Everyone has cashed out'); return; }
    pickMode = mode;
    $('pickTitle').textContent = mode === 'rebuy' ? 'Who is rebuying?' : 'Who is cashing out?';
    $('pickList').replaceChildren(...list.map(p => {
      const li = clone('tplPick'), b = li.querySelector('button');
      paint(li.querySelector('.avatar'), p.name);
      put(li, '.name', p.name);
      put(li, '.meta', `In ${money(L.money(p), C())} · ${plural(p.buys.length, 'buy-in')}`);
      b.dataset.name = p.name;
      return li;
    }));
    $('pick').showModal();
  }
  $('pickList').addEventListener('click', e => {
    const b = e.target.closest('button[data-name]'), p = b && findPlayer(b.dataset.name); // by name: the list may be stale
    if (!p) return;
    $('pick').close();
    if (pickMode === 'rebuy') rebuy(p); else cashOut(p);
  });
  $('pickClose').addEventListener('click', () => $('pick').close());

  // ---- Game settings sheet ----
  function openMenu() {
    if (!host) return;
    $('menuName').value = state.name;
    $('menuCur').value = state.currency;
    $('menuBomb').value = String(state.bombEvery);
    $('menuPause').textContent = state.since ? 'Pause the clock' : 'Resume the clock';
    $('menu').showModal();
  }
  $('menuClose').addEventListener('click', () => $('menu').close());
  $('menuName').addEventListener('input', e => { state.name = e.target.value; save(); render(); });
  $('menuCur').addEventListener('change', e => { state.currency = e.target.value; commit(); });
  $('menuBomb').addEventListener('change', e => {
    state.bombEvery = +e.target.value;
    if (state.bombEvery) state.bombsDone = Math.floor(elapsedNow() / bombMs()); // the next one is due at the next full interval
    commit();
  });
  $('menuPause').addEventListener('click', () => {
    if (state.since) pause(); else state.since = Date.now();
    commit();
    $('menuPause').textContent = state.since ? 'Pause the clock' : 'Resume the clock';
  });
  const openTable = () => { const w = window.open(`${location.pathname}#table`, 'pokerTable'); if (!w) location.hash = '#table'; };
  $('menuTable').addEventListener('click', openTable);
  $('menuEnd').addEventListener('click', () => {
    $('menu').close();
    const next = state.players.find(q => q.count === null);
    if (!next) { flash('Everyone has cashed out'); return; }
    cashOut(next, true); // the clock stops by itself when the last player cashes out
  });
  twoTap($('menuDelete'), 'Tap again to delete the game', () => {
    $('menu').close();
    const snap = snapshot();
    state = fresh();
    commit();
    go('home');
    offerUndo(snap, 'Game deleted');
  });

  // ---- wiring: tabs, home, players, stats, profile ----
  $('tabbar').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) go(b.dataset.tab); });
  function startSetup() {
    if (!host) return;
    state = { ...fresh(), phase: 'setup', name: `${new Date().toLocaleDateString('en-US', { weekday: 'long' })} game` };
    inGame = true;
    viewing = null;
    commit();
    window.scrollTo(0, 0);
  }
  $('fab').addEventListener('click', () => { if (running()) { inGame = true; render(); } else startSetup(); });
  $('homeGame').addEventListener('click', () => $('fab').click());
  const ideas = $('ideas');
  ideas.replaceChildren(...IDEAS.map(([h, p]) => { const el = clone('tplIdea'); put(el, 'h4', h); put(el, 'p', p); return el; }));

  $('playerAdd').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('newProfile').value.trim();
    if (!name) return;
    if (savedName(name)) { flash(`${savedName(name)} is already saved`); return; }
    remember(name);
    $('newProfile').value = '';
    boardPeriod = 'all'; // players with no games yet only show on All time
    render();
    flash(`${name} saved`);
  });
  $('playerList').addEventListener('click', e => {
    const b = e.target.closest('button[data-name]');
    if (!b) return;
    if (b.dataset.act === 'forget') { forgetProfile(b.dataset.name); render(); return; }
    openPerson(b.dataset.name);
  });
  $('podium').addEventListener('click', e => { const b = e.target.closest('button[data-name]'); if (b) openPerson(b.dataset.name); });
  $('boardSort').addEventListener('click', e => { const b = e.target.closest('button[data-sort]'); if (b) { boardSort = b.dataset.sort; render(); } });
  $('boardPeriod').addEventListener('click', e => { const b = e.target.closest('button[data-period]'); if (b) { boardPeriod = b.dataset.period; render(); } });
  $('potm').addEventListener('click', e => { if (e.currentTarget.dataset.name) openPerson(e.currentTarget.dataset.name); });
  $('personBack').addEventListener('click', () => { person = null; render(); window.scrollTo(0, 0); });
  $('statPeriod').addEventListener('change', render);
  $('statWho').addEventListener('change', e => { statWho = e.target.value; render(); });
  $('leaderboard').addEventListener('click', e => { const b = e.target.closest('button[data-name]'); if (b) openPerson(b.dataset.name); });
  $('prefMe').addEventListener('change', e => { prefs.me = e.target.value || null; savePrefs(); render(); });
  $('prefCur').addEventListener('change', e => { prefs.currency = e.target.value; savePrefs(); render(); });
  $('prefBuyIn').addEventListener('input', e => { const v = amountVal(e.target.value); if (v) { prefs.buyIn = v; savePrefs(); } });
  $('profTable').addEventListener('click', openTable);
  $('csvBtn').addEventListener('click', () => {
    if (!games.length) { flash('No finished games yet'); return; }
    const blob = new Blob(['\ufeff' + L.toCSV(games)], { type: 'text/csv;charset=utf-8' }); // BOM: Excel reads æøå right
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `kongens-nytorv-games-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    flash('Downloaded: open it in Excel or Numbers');
  });
  $('h2hWho').addEventListener('change', e => { h2hWho = e.target.value; render(); });
  $('linkBtn').addEventListener('click', async () => {
    const id = $('linkWho').value;
    if (!id) { flash('Pick your name first'); return; }
    try { me = await ON.linkPlayer(id); } catch (err) { flash(err.message || "Couldn't link. Try again."); refreshPlayers(); return; }
    prefs.me = me.name;
    await refreshPlayers();
    flash(`Linked. You're ${me.name} for good.`);
  });

  // ---- wiring: new game ----
  $('setupBack').addEventListener('click', () => { if (!state.players.length) state = fresh(); save(); go('home'); });
  $('setupAmount').addEventListener('click', () => openPad({
    title: 'Buy-in', who: 'Per player, can be changed later', value: state.buyIn,
    onConfirm: v => {
      if (!(v > 0)) return 'Type an amount above 0';
      const old = state.buyIn;
      state.buyIn = round(v);
      for (const p of state.players) if (p.buys.length === 1 && p.buys[0].money === old) p.buys[0].money = state.buyIn;
      commit();
    },
  }));
  $('gameName').addEventListener('input', e => { state.name = e.target.value; save(); });
  $('setupCur').addEventListener('change', e => { state.currency = e.target.value; commit(); });
  $('setupBomb').addEventListener('change', e => { state.bombEvery = +e.target.value; commit(); });
  $('setupAdd').addEventListener('click', () => openAdd('setup'));
  $('setupPractice').addEventListener('change', e => { state.practice = e.target.checked; commit(); });
  $('setupSeats').addEventListener('click', () => {
    if (state.players.length < 2) return;
    const byName = new Map(state.players.map(p => [lc(p.name), p]));
    const { order, dealer } = L.drawSeats(state.players.map(p => p.name));
    state.players = order.map(n => byName.get(lc(n)));
    state.seated = true;
    state.dealer = order[dealer];
    commit();
    flash(`Seats drawn. ${state.dealer} deals first.`);
  });
  $('setupPlayers').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]'), i = b ? +b.dataset.i : -1, p = state.players[i];
    if (!p) return;
    if (b.dataset.act === 'remove') { const snap = snapshot(); state.players.splice(i, 1); commit(); offerUndo(snap, `${p.name} removed`); return; }
    openPad({
      title: 'Buy-in', who: p.name, value: L.money(p),
      onConfirm: v => {
        if (!(v > 0)) return 'Type an amount above 0';
        const q = findPlayer(p.name);
        if (!q) return gone(p.name);
        q.buys = [{ money: round(v), at: Date.now() }];
        commit();
      },
    });
  });
  $('startGame').addEventListener('click', () => {
    if (state.players.length < 2) return;
    unlockAudio();
    const now = Date.now();
    for (const p of state.players) p.buys[0].at = now;
    Object.assign(state, { phase: 'live', since: now, startedAt: now, elapsed: 0, bombsDone: 0 });
    commit();
    window.scrollTo(0, 0);
  });

  // ---- wiring: live game ----
  $('liveBack').addEventListener('click', () => go('home'));
  $('liveMenu').addEventListener('click', openMenu);
  $('liveAdd').addEventListener('click', () => openAdd('live'));
  $('liveAvatars').addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (b) openPlayer(+b.dataset.i); });
  $('dockRebuy').addEventListener('click', () => openPick('rebuy'));
  $('dockCash').addEventListener('click', () => openPick('cash'));
  $('actFilter').addEventListener('click', e => { const b = e.target.closest('button.filter'); if (b) { actFilter = b.dataset.name || null; render(); } });
  $('activity').addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (b) editTx(+b.dataset.i, +b.dataset.j); });
  $('bombDone').addEventListener('click', () => { state.bombsDone = Math.floor(elapsedNow() / bombMs()); commit(); });
  $('finishGame').addEventListener('click', async () => {
    const co = L.cashOut(state.players);
    if (!co.ok || saving) return;
    dropUndo();
    pause();
    const end = Date.now();
    const results = co.results.map(r => {
      const p = findPlayer(r.name);
      return { ...r, ms: Math.max(0, (p?.outAt ?? end) - (p?.buys[0]?.at ?? state.startedAt ?? end)), rebuys: Math.max(0, (p?.buys.length ?? 1) - 1) };
    });
    const rec = {
      name: state.name || 'Home game', currency: state.currency, endedAt: end, startedAt: state.startedAt,
      duration: elapsedNow(), pot: co.pot, results, transfers: L.settle(co.results),
    };
    if (state.practice) { // practice: show the results, save nothing
      rec.practice = true;
      state.phase = 'done';
      state.result = rec;
      inGame = true;
      commit();
      window.scrollTo(0, 0);
      return;
    }
    saving = true;
    render();
    try {
      const id = await S.addGame(rec);
      if (typeof id === 'string' && id) rec.id = id;
    } catch {
      saving = false;
      flash("Couldn't save the game. Try again.");
      render();
      return;
    }
    saving = false;
    state.phase = 'done';
    state.result = rec;
    inGame = true;
    commit();
    window.scrollTo(0, 0);
  });

  // ---- wiring: results and table ----
  const leaveResults = () => {
    if (viewing) { viewing = null; render(); window.scrollTo(0, 0); return; }
    state = fresh();
    if (host) save(); // viewers only leave the screen; the host's game stays as it is
    go('home');
  };
  $('resBack').addEventListener('click', leaveResults);
  $('resDone').addEventListener('click', leaveResults);
  $('resCopy').addEventListener('click', () => {
    const r = shownRecord();
    if (!r) return;
    navigator.clipboard.writeText(resultText(r)).then(() => flash('Results copied'), () => flash("Couldn't copy. Select the results and copy them instead."));
  });
  $('resImage').addEventListener('click', () => { const r = shownRecord(); if (r) saveImage(r); });
  // Settled marks: the host ticks off each payment once it's done; everyone sees it.
  $('rcSettle').addEventListener('click', async e => {
    const b = e.target.closest('button[data-act="paid"]'), r = shownRecord();
    if (!b || !host || !r?.id) return;
    const i = +b.closest('li').dataset.i, rec = JSON.parse(JSON.stringify(r));
    rec.transfers[i].paid = !rec.transfers[i].paid;
    try { await S.updateGame(r.id, rec); } catch (err) { flash(err.message || "Couldn't save that. Try again."); return; }
    r.transfers[i].paid = rec.transfers[i].paid;
    if (!viewing) commit(); else render(); // the game still on screen is saved too, so friends' results screens show the tick
  });
  twoTap($('resDelete'), 'Tap again to delete for good', async () => {
    const r = shownRecord();
    if (!host || !r?.id) return;
    try { await S.deleteGame(r.id); } catch (err) { flash(err.message || "Couldn't delete the game. Try again."); return; }
    if (!viewing) { state = fresh(); save(); }
    flash('Game deleted');
    go('home');
  });
  // Run It Back: the next game with the same players, buy-in, currency and bomb pots.
  $('resRunBack').addEventListener('click', () => {
    const r = shownRecord();
    if (!host || !r) return;
    const base = viewing ? { buyIn: prefs.buyIn, currency: r.currency, bombEvery: 0 } : { buyIn: state.buyIn, currency: state.currency, bombEvery: state.bombEvery };
    viewing = null;
    person = null;
    state = { ...fresh(), ...base, phase: 'setup', name: r.name || `${new Date().toLocaleDateString('en-US', { weekday: 'long' })} game`,
      players: r.results.map(x => ({ name: x.name, buys: [{ money: base.buyIn, at: Date.now() }], count: null, outAt: null })) };
    inGame = true;
    commit();
    window.scrollTo(0, 0);
    flash('Same players are in. Tap Start game when ready.');
  });
  $('tableHome').addEventListener('click', () => { history.replaceState(null, '', location.pathname + location.search); go('home'); });
  $('fullscreenBtn').addEventListener('click', () => { try { $('viewTable').requestFullscreen?.()?.catch(() => {}); } catch {} });
  window.addEventListener('hashchange', () => (gate === 'noinvite' && joinCode() ? location.reload() : render()));
  let resizeFrame = 0; // charts are drawn at their pixel size, so redraw them when the window changes
  window.addEventListener('resize', () => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(render); });

  // ---- start ----
  for (const sel of document.querySelectorAll('.cur-select')) sel.replaceChildren(...Object.keys(CURRENCIES).map(k => new Option(CUR_NAMES[k], k)));
  for (const sel of document.querySelectorAll('.bomb-select')) sel.replaceChildren(new Option('Off', '0'), ...[15, 20, 30, 45, 60].map(m => new Option(`Every ${m} min`, String(m))));
  document.addEventListener('pointerdown', unlockAudio, { once: true }); // browsers only allow sound after a tap
  // ---- online: sign in, join with an invite link, account ----
  const appUrl = () => location.origin + location.pathname;
  const joinCode = () => (location.hash.match(/^#join=([A-Za-z0-9]+)/) || location.search.match(/[?&]join=([A-Za-z0-9]+)/) || [])[1] || null;
  const gateErr = msg => { $('gateError').textContent = msg; $('gateError').hidden = !msg; };
  function renderGate() {
    const show = { loading: 'gateLoading', signin: 'gateSignIn', join: 'gateJoin', noinvite: 'gateNoInvite' }[gate];
    for (const id of ['gateLoading', 'gateSignIn', 'gateJoin', 'gateNoInvite']) $(id).hidden = id !== show;
    $('gateSignOut').hidden = gate !== 'join' && gate !== 'noinvite';
  }
  const noInvite = text => { $('gateNoInviteText').textContent = text; gate = 'noinvite'; render(); };
  async function showJoin(code) {
    gateErr('');
    let g = null;
    try { g = await ON.gameByCode(code); } catch {
      noInvite("Can't reach the server right now. Check your connection, then open the invite link again.");
      return;
    }
    if (!g) { noInvite("This invite link doesn't work. Ask the host for a new one."); return; }
    joinCodeShown = code;
    $('gateJoinGame').textContent = g.name || 'Home game';
    $('joinList').replaceChildren(...g.players.map(p => {
      const li = clone('tplPick'), b = li.querySelector('button');
      paint(li.querySelector('.avatar'), p.name);
      put(li, '.name', p.name);
      put(li, '.meta', p.claimed ? 'Already taken' : 'Tap if this is you');
      b.disabled = p.claimed;
      b.dataset.name = p.name;
      return li;
    }));
    gate = 'join';
    render();
  }
  async function claimAs(name) {
    gateErr('');
    try { await ON.claim(joinCodeShown, name); } catch (err) {
      if (err.code === 'taken') await showJoin(joinCodeShown); // refresh the list first, then show why
      gateErr(err.message || "Couldn't join. Try again.");
      return;
    }
    history.replaceState(null, '', location.pathname);
    location.reload(); // the store binds to the signed-in player when it starts
  }
  const inviteLink = async () => {
    const code = ON ? await ON.inviteCode().catch(() => null) : null;
    return code ? `${appUrl()}#join=${code}` : null;
  };
  // The QR code is drawn by the qrcode-generator library; without it the sheet still shows the link.
  function drawQr(el, url) {
    try {
      const q = qrcode(0, 'M');
      q.addData(url);
      q.make();
      el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); // our own link only
      el.hidden = false;
    } catch { el.hidden = true; }
  }
  let inviteUrl = '';
  async function invite() {
    if (!ON || !host) return;
    const url = await inviteLink();
    if (!url) { flash('Saving the game… try again in a moment'); return; }
    inviteUrl = url;
    drawQr($('inviteQr'), url);
    $('inviteLink').textContent = url;
    $('inviteShare').hidden = !navigator.share;
    $('inviteSheet').showModal();
  }
  if (ON) {
    // Email + password, no email sent: Create account makes the account, Sign in uses it.
    // Success reloads the page, which keeps an invite's #join=CODE so the friend goes on to "Which one are you?".
    const authGo = async create => {
      const form = $('gateSignIn'), buttons = form.querySelectorAll('button');
      if (!form.reportValidity()) return;
      gateErr('');
      buttons.forEach(b => { b.disabled = true; });
      try {
        const email = $('gateEmail').value.trim(), pass = $('gatePass').value;
        await (create ? ON.signUp(email, pass) : ON.signInPassword(email, pass));
        location.reload();
      } catch (err) {
        gateErr(err.message || 'Something went wrong. Try again.');
        buttons.forEach(b => { b.disabled = false; });
      }
    };
    $('gateSignIn').addEventListener('submit', e => { e.preventDefault(); authGo(false); });
    $('gateCreate').addEventListener('click', () => authGo(true));
    $('passForm').addEventListener('submit', async e => {
      e.preventDefault();
      const pw = $('newPass').value;
      if (pw.length < 6) { flash('Use at least 6 characters'); return; }
      try { await ON.setPassword(pw); $('newPass').value = ''; flash('Password saved. Use it next time you sign in.'); }
      catch (err) { flash(err.message || "Couldn't save the password"); }
    });
    const signOut = () => ON.signOut().then(() => location.reload(), () => flash("Couldn't sign out. Check your connection."));
    $('gateSignOut').addEventListener('click', signOut);
    $('signOut').addEventListener('click', signOut);
    $('joinList').addEventListener('click', e => { const b = e.target.closest('button[data-name]'); if (b && !b.disabled) claimAs(b.dataset.name); });
    $('joinNew').addEventListener('submit', e => { e.preventDefault(); const n = $('joinName').value.trim(); if (n) claimAs(n); });
    $('setupInvite').addEventListener('click', invite);
    $('liveInvite').addEventListener('click', invite);
    $('inviteClose').addEventListener('click', () => $('inviteSheet').close());
    $('inviteCopy').addEventListener('click', () => navigator.clipboard.writeText(inviteUrl)
      .then(() => flash('Invite link copied. Paste it in the group chat.'), () => flash('Select the link above and copy it')));
    $('inviteShare').addEventListener('click', () => navigator.share({ title: 'Kongens Nytorv Home Games', text: 'Join the game and get your own account', url: inviteUrl }).catch(() => {}));
    $('menuInvite').addEventListener('click', () => { $('menu').close(); invite(); });
  }
  $('myStats').addEventListener('click', () => { if (prefs.me) openPerson(prefs.me); else flash('Your account is not linked to a player yet'); });

  let booted = false;
  function startApp() {
    gate = null;
    render();
    renderStatus();
    S.init({
      onGame: g => {
        state = normalize(g);
        dropUndo(); // the game changed elsewhere: an undo snapshot from before would wipe that
        if (!booted) { booted = true; inGame = state.phase !== 'none'; } // reopen a game that was running
        render();
      },
      onHistory: h => {
        games = (Array.isArray(h) ? h : []).map(record).filter(Boolean).sort((a, b) => b.endedAt - a.endedAt);
        render();
      },
      onStatus: text => { storeStatus = text || ''; renderStatus(); },
    });
    refreshPlayers();
  }
  if (!ON) startApp();
  else {
    render();
    let first = true;
    ON.onAuth(async user => {
      if (!first) { location.reload(); return; } // signed in or out: start over as the new user
      first = false;
      if (!user) {
        const invited = !!joinCode();
        $('gateHint').textContent = invited
          ? "You're invited! Create your account with your email and a password you choose, then pick your name."
          : 'New here? Type your email, choose a password and tap Create account. Already have one? Sign in.';
        $('gateCreate').className = `btn ${invited ? 'primary' : 'soft'}`;
        $('gateLogin').className = `btn ${invited ? 'soft' : 'primary'}`;
        gate = 'signin';
        render();
        return;
      }
      account = user.email || '';
      try { [host, me] = await Promise.all([ON.isAdmin(), ON.myPlayer()]); } catch {
        noInvite("Can't reach the server right now. Check your connection, then reload the page.");
        return;
      }
      prefs.me = me ? me.name : null; // online, "me" is your linked player only: no switching to someone else
      const code = joinCode();
      if (code && !me && !host) { showJoin(code); return; }
      if (!host && !me) {
        noInvite(`You're signed in as ${account}, but you're not in the group yet. Ask the host for an invite link and open it on this device.`);
        return;
      }
      if (code) history.replaceState(null, '', location.pathname);
      startApp();
    });
  }
  setInterval(tick, 1000);
})();
