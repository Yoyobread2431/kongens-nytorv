const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('./logic.js');

const MINUS = '−';
const c = (x) => Math.round(x * 100);
const centsSum = (arr, f) => arr.reduce((s, x) => s + c(f(x)), 0);
const P = (name, buys, count = null) => ({ name, buys: buys.map((money) => ({ money })), count });

// Deterministic PRNG so fuzz failures are reproducible.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGame(rand) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const n = 2 + Math.floor(rand() * 7);
  const players = [];
  for (let i = 0; i < n; i++) {
    const buys = [];
    for (let k = 1 + Math.floor(rand() * 3); k > 0; k--) buys.push(pick([5, 7.5, 10, 20, 25, 33.33, 50, 200]));
    players.push(P('P' + i, buys));
  }
  // Split the pot (in cents) randomly across the players' final stacks.
  const pot = c(L.totals(players).money);
  const w = players.map(() => (rand() < 0.15 ? 0 : rand()));
  const W = w.reduce((a, b) => a + b, 0) || 1;
  let left = pot;
  players.forEach((p, i) => { const cc = i === n - 1 ? left : Math.floor((w[i] / W) * pot); p.count = cc / 100; left -= cc; });
  return players;
}

function checkSettle(results, transfers) {
  const bal = new Map(results.map((r) => [r.name, 0]));
  for (const t of transfers) {
    assert.ok(c(t.amount) > 0, 'no zero or negative transfers');
    bal.set(t.from, bal.get(t.from) - c(t.amount));
    bal.set(t.to, bal.get(t.to) + c(t.amount));
  }
  for (const r of results) {
    assert.equal(bal.get(r.name), c(r.net), `transfers for ${r.name} add up to their net`);
    if (c(r.net) === 0) assert.ok(!transfers.some((t) => t.from === r.name || t.to === r.name), 'break-even never appears');
  }
  assert.ok(transfers.length <= Math.max(0, results.length - 1), 'at most n-1 transfers');
}

test('works as a classic browser script (global PokerLogic)', () => {
  const ctx = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'logic.js'), 'utf8'), ctx);
  assert.equal(typeof ctx.PokerLogic.cashOut, 'function');
});

test('money, totals', () => {
  const a = P('A', [20, 50]);
  const b = P('B', [0.1, 0.2]);
  assert.equal(L.money(a), 70);
  assert.equal(L.money(b), 0.3); // no float drift
  assert.deepEqual(L.totals([a, b]), { money: 70.3, buys: 4 });
  assert.deepEqual(L.totals([]), { money: 0, buys: 0 });
});

test('fmtTime', () => {
  assert.equal(L.fmtTime(0), '0:00:00');
  assert.equal(L.fmtTime(59000), '0:00:59');
  assert.equal(L.fmtTime(59999), '0:00:59');
  assert.equal(L.fmtTime(60000), '0:01:00');
  assert.equal(L.fmtTime(3723000), '1:02:03');
  assert.equal(L.fmtTime(36000000), '10:00:00');
  assert.equal(L.fmtTime(123456789), '34:17:36');
});

test('fmtMoney: decimals and grouping', () => {
  assert.equal(L.fmtMoney(0), '0');
  assert.equal(L.fmtMoney(20), '20');
  assert.equal(L.fmtMoney(1234.5), '1,234.5');
  assert.equal(L.fmtMoney(1234.567), '1,234.57');
  assert.equal(L.fmtMoney(0.05), '0.05');
  assert.equal(L.fmtMoney(0.1 + 0.2), '0.3');
  assert.equal(L.fmtMoney(1000000), '1,000,000');
  assert.equal(L.fmtMoney(-0.001), '0');
});

test('fmtNet: + / U+2212 / 0', () => {
  assert.equal(L.fmtNet(40), '+40');
  assert.equal(L.fmtNet(-20), MINUS + '20');
  assert.equal(L.fmtNet(0), '0');
  assert.equal(L.fmtNet(-0), '0');
  assert.equal(L.fmtNet(0.004), '0');
  assert.equal(L.fmtNet(-0.004), '0');
  assert.equal(L.fmtNet(1234.5), '+1,234.5');
  assert.equal(L.fmtNet(-1234.56), MINUS + '1,234.56');
  assert.ok(!L.fmtNet(-5).includes('-'), 'never a hyphen-minus');
});

test('cashOut: chips are worth face value', () => {
  const r = L.cashOut([P('A', [200], 340), P('B', [200, 200], 60), P('C', [200], 400)]);
  assert.equal(r.ok, true);
  assert.deepEqual([r.counted, r.pot, r.diff], [800, 800, 0]);
  assert.deepEqual(r.results, [
    { name: 'C', in: 200, out: 400, net: 200 },
    { name: 'A', in: 200, out: 340, net: 140 },
    { name: 'B', in: 400, out: 60, net: -340 },
  ]);
});

test('cashOut fuzz: sum(out) === pot and sum(net) === 0 in cents', () => {
  const rand = rng(42);
  for (let i = 0; i < 2000; i++) {
    const players = randomGame(rand);
    const pot = c(L.totals(players).money);
    const r = L.cashOut(players);
    assert.equal(r.ok, true);
    assert.equal(centsSum(r.results, (x) => x.out), pot);
    assert.equal(centsSum(r.results, (x) => x.net), 0);
    for (const x of r.results) assert.ok(x.out >= 0);
    checkSettle(r.results, L.settle(r.results));
  }
});

test('cashOut: decimal counts and a zero stack', () => {
  const r = L.cashOut([P('A', [10], 12.5), P('B', [10], 7.5), P('C', [5], 0), P('D', [5], 10)]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.results.map((x) => [x.name, x.net]), [['D', 5], ['A', 2.5], ['B', -2.5], ['C', -5]]);
});

test('cashOut: ok is false for bad counts, still returns a preview', () => {
  const two = (a, b) => L.cashOut([P('A', [20], a), P('B', [20], b)]);
  for (const [a, b, why] of [
    [null, 40, 'missing count'],
    [undefined, 40, 'undefined count'],
    [NaN, 40, 'NaN count'],
    [-10, 50, 'negative count'],
    [0, 39, 'count mismatch'],
  ]) {
    const r = two(a, b);
    assert.equal(r.ok, false, why);
    assert.equal(r.results.length, 2, why + ': preview results');
  }
  assert.deepEqual(L.cashOut([]), { ok: false, counted: 0, pot: 0, diff: 0, results: [] });
});

test('cashOut: counted, pot and diff sign', () => {
  const over = L.cashOut([P('A', [20], 21), P('B', [20], 20)]);
  assert.deepEqual([over.counted, over.pot, over.diff], [41, 40, 1]);
  const under = L.cashOut([P('A', [20], null), P('B', [20], 20)]);
  assert.deepEqual([under.counted, under.pot, under.diff], [20, 40, -20]);
  assert.deepEqual(under.results.map((x) => [x.name, x.out]), [['B', 20], ['A', 0]]);
});

test('settle: greedy, biggest loser pays biggest winner', () => {
  const results = [
    { name: 'A', net: 50 }, { name: 'B', net: 10 }, { name: 'E', net: 0 },
    { name: 'D', net: -25 }, { name: 'C', net: -35 },
  ];
  const t = L.settle(results);
  assert.deepEqual(t, [
    { from: 'C', to: 'A', amount: 35 },
    { from: 'D', to: 'A', amount: 15 },
    { from: 'D', to: 'B', amount: 10 },
  ]);
  checkSettle(results, t);
});

test('settle: cents are exact', () => {
  const results = [{ name: 'A', net: 0.1 }, { name: 'B', net: 0.2 }, { name: 'C', net: -0.3 }];
  const t = L.settle(results);
  assert.deepEqual(t, [{ from: 'C', to: 'B', amount: 0.2 }, { from: 'C', to: 'A', amount: 0.1 }]);
  checkSettle(results, t);
});

test('settle: already settled gives []', () => {
  assert.deepEqual(L.settle([]), []);
  assert.deepEqual(L.settle([{ name: 'A', net: 0 }, { name: 'B', net: 0 }]), []);
});

const game = (endedAt, nets) => ({ endedAt, results: Object.entries(nets).map(([name, net]) => ({ name, net })) });

test('leaderboard: names, unsorted history, streaks, bestNight, sort', () => {
  const g1 = game(1, { anna: 30, Bob: -30 });
  const g2 = game(2, { Anna: 10, bob: -10 });
  const g3 = game(3, { BOB: 5, ANNA: -5 });
  const g4 = game(4, { ' Anna ': 0, Bob: 20, Cy: -20 });
  const rows = L.leaderboard([g3, g1, g4, g2]);
  assert.deepEqual(rows, [
    { name: 'Anna', games: 4, wins: 2, losses: 1, net: 35, avg: 8.75, streak: 0, bestStreak: 2, bestNight: 30 },
    { name: 'Bob', games: 4, wins: 2, losses: 2, net: -15, avg: -3.75, streak: 2, bestStreak: 2, bestNight: 20 },
    { name: 'Cy', games: 1, wins: 0, losses: 1, net: -20, avg: -20, streak: -1, bestStreak: 0, bestNight: -20 },
  ]);
  assert.deepEqual(L.leaderboard([]), []);
});

test('leaderboard: streak sign, break-even reset, bestStreak', () => {
  const seq = (name, nets) => nets.map((net, i) => game(i + 1, { [name]: net }));
  const row = (name, nets) => L.leaderboard(seq(name, nets).reverse())[0];
  assert.equal(row('L', [5, -1, -2]).streak, -2);
  assert.equal(row('W', [-1, 5, 6, 7]).streak, 3);
  const r = row('Z', [1, 1, 0, 1]);
  assert.equal(r.streak, 1); // break-even ended the W2
  assert.equal(r.bestStreak, 2);
  const b = row('B', [1, 1, -1, 1, 1, 1, -1]);
  assert.deepEqual([b.streak, b.bestStreak, b.bestNight], [-1, 3, 1]);
  assert.equal(row('N', [-5, -2, -9]).bestNight, -2); // never won: negative best night
  assert.equal(L.leaderboard([game(1, { F: 0.1 }), game(2, { F: 0.2 })])[0].net, 0.3);
});

test('leaderboard: ties sort by more wins, then name', () => {
  const rows = L.leaderboard([
    game(1, { Bea: -10, Al: 10 }),
    game(2, { Bea: 10, Al: -10 }),
    game(3, { Cat: 5, Dee: -5 }),
    game(4, { Cat: 5, Dee: -5 }),
    game(5, { Dee: 10, Cat: -10 }),
    game(6, { Eve: 0, al: 0 }),
    game(7, { Fay: 1, Gus: -1 }),
  ]);
  assert.deepEqual(rows.map((r) => [r.name, r.net, r.wins]), [
    ['Fay', 1, 1],
    ['Cat', 0, 2],
    ['al', 0, 1],
    ['Bea', 0, 1],
    ['Dee', 0, 1],
    ['Eve', 0, 0],
    ['Gus', -1, 0],
  ]);
});

test('playerStats: profit, wins, averages, hourly, series, since filter', () => {
  const H = 3600000;
  const hist = [
    { endedAt: 3000, duration: 2 * H, results: [{ name: 'Anna', net: -50 }, { name: 'Bo', net: 50 }] },
    { endedAt: 1000, duration: 4 * H, results: [{ name: 'anna ', net: 120, ms: 3 * H }, { name: 'Bo', net: -120 }] },
    { endedAt: 2000, duration: 1 * H, results: [{ name: 'Anna', net: 0 }, { name: 'Bo', net: 0 }] },
  ];
  const s = L.playerStats(hist, 'ANNA');
  assert.equal(s.sessions, 3);
  assert.equal(s.net, 70);
  assert.deepEqual([s.wins, s.losses], [1, 1]);
  assert.equal(s.winRate, 1 / 3);
  assert.deepEqual([s.avgWin, s.avgLoss], [120, -50]);
  assert.equal(s.timeMs, 6 * H); // 3h recorded + 1h + 2h game durations
  assert.equal(s.hourly, 11.67);
  assert.equal(s.avgSessionMs, 2 * H);
  assert.deepEqual(s.series.map((p) => p.total), [120, 120, 70]); // oldest game first
  assert.equal(L.playerStats(hist, 'Anna', 2500).sessions, 1);
  assert.deepEqual(L.playerStats(hist, 'Nobody'), {
    sessions: 0, net: 0, wins: 0, losses: 0, winRate: 0, avgWin: 0, avgLoss: 0, avgNet: 0,
    biggestWin: 0, worstLoss: 0, bestStreak: 0, timeMs: 0, hourly: 0, avgSessionMs: 0, series: [],
  });
  assert.deepEqual([s.avgNet, s.biggestWin, s.worstLoss, s.bestStreak], [23.33, 120, -50, 1]);
  assert.deepEqual(s.series.map((p) => [p.at, p.net]), [[1000, 120], [2000, 0], [3000, -50]]);
  assert.equal(s.series[0].game, hist[1]); // the record itself, so a chart dot can open it
});

test('playerStats: best streak counts wins in a row, break-even ends it', () => {
  const nets = [5, 5, 0, 5, 5, 5, -1, 5];
  const s = L.playerStats(nets.map((net, i) => game(i + 1, { A: net })), 'a');
  assert.equal(s.bestStreak, 3);
  assert.deepEqual([s.biggestWin, s.worstLoss], [5, -1]);
  const losing = L.playerStats([game(1, { A: -5 }), game(2, { A: -2 })], 'A');
  assert.deepEqual([losing.biggestWin, losing.worstLoss, losing.bestStreak], [0, -5, 0]);
});

test('rank: most money, best player (3+ games first), most games', () => {
  const board = L.leaderboard([
    game(1, { Al: 100, Bo: -40, Cy: -60 }),
    game(2, { Al: -50, Bo: 20, Cy: 30, Di: 0 }),
    game(3, { Al: -40, Bo: 30, Cy: 10 }),
    game(4, { Di: 90, Ed: -90 }),
  ]);
  const names = (by) => L.rank(board, by).map((r) => r.name);
  assert.deepEqual(names('net'), ['Di', 'Bo', 'Al', 'Cy', 'Ed']); // Bo and Al both +10, Bo has more wins
  assert.deepEqual(names(), names('net'));
  // Bo 3.33, Al 3.33, Cy -6.67 have 3 games; Di (45 a game) and Ed have fewer, so they come after.
  assert.deepEqual(names('avg'), ['Bo', 'Al', 'Cy', 'Di', 'Ed']);
  assert.deepEqual(names('games'), ['Bo', 'Al', 'Cy', 'Di', 'Ed']);
  assert.deepEqual(L.rank([], 'avg'), []);
  assert.notEqual(L.rank(board), board); // a copy, the input stays as it was
});

test('gameStats: headline numbers, rebuys only when recorded', () => {
  const g = { pot: 1200, duration: 7200000, results: [
    { name: 'Bo', net: -300, rebuys: 2 }, { name: 'Al', net: 500, rebuys: 0 }, { name: 'Cy', net: -200, rebuys: 1 },
  ] };
  const s = L.gameStats(g);
  assert.deepEqual([s.players, s.pot, s.duration, s.rebuys], [3, 1200, 7200000, 3]);
  assert.deepEqual([s.winner.name, s.loser.name], ['Al', 'Bo']);
  const old = L.gameStats({ pot: 100, duration: 0, results: [{ name: 'A', net: 0 }, { name: 'B', net: 0 }] });
  assert.deepEqual([old.rebuys, old.winner, old.loser], [null, null, null]);
  assert.deepEqual(L.gameStats({}), { players: 0, pot: 0, duration: 0, rebuys: null, winner: null, loser: null });
});

test('monthly: player net or total pot per month of one year', () => {
  const at = (y, m) => new Date(y, m, 15).getTime();
  const hist = [
    { endedAt: at(2026, 0), pot: 400, results: [{ name: 'Anna', net: 100.5 }] },
    { endedAt: at(2026, 0), pot: 600, results: [{ name: 'Anna', net: -30 }] },
    { endedAt: at(2026, 8), pot: 200, results: [{ name: 'Bo', net: 20 }] },
    { endedAt: at(2025, 8), pot: 999, results: [{ name: 'Anna', net: 999 }] },
  ];
  const pots = L.monthly(hist, 2026);
  assert.equal(pots.length, 12);
  assert.deepEqual([pots[0], pots[8], pots[5]], [1000, 200, 0]);
  const anna = L.monthly(hist, 2026, 'anna');
  assert.deepEqual([anna[0], anna[8]], [70.5, 0]);
});
