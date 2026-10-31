// PokerLogic: pure game math. No DOM, no storage. Money is handled in integer cents internally.
(function (root) {
  const cents = (x) => Math.round((Number(x) || 0) * 100);
  const num = (c) => (Number.isFinite(c) ? c : 0); // null / missing counts are 0
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const moneyCents = (p) => sum(p.buys || [], (b) => cents(b.money));

  const api = {
    money: (p) => moneyCents(p) / 100,

    totals: (players) => ({
      money: sum(players, moneyCents) / 100,
      buys: sum(players, (p) => (p.buys || []).length),
    }),

    fmtTime(ms) {
      const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
      const pad = (n) => String(n).padStart(2, '0');
      return Math.floor(s / 3600) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
    },

    // `|| 0` turns -0 and NaN into 0 so they never print as "-0" / "NaN".
    fmtMoney: (n) => (Math.round(n * 100) / 100 || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }),

    fmtNet(n) {
      const c = Math.round(Math.abs(n) * 100) || 0;
      return c === 0 ? '0' : (n > 0 ? '+' : '\u2212') + api.fmtMoney(c / 100);
    },

    // Chips are worth their face value: a player's count is the money in front of them.
    cashOut(players) {
      const ins = players.map(moneyCents);
      const outs = players.map((p) => cents(num(p.count)));
      const pot = sum(ins, (c) => c), counted = sum(outs, (c) => c);
      const results = players
        .map((p, i) => ({ name: p.name, in: ins[i] / 100, out: outs[i] / 100, net: (outs[i] - ins[i]) / 100 }))
        .sort((a, b) => cents(b.net) - cents(a.net));
      const ok = players.length > 0 && counted === pot &&
        players.every((p) => Number.isFinite(p.count) && p.count >= 0);
      return { ok, counted: counted / 100, pot: pot / 100, diff: (counted - pot) / 100, results };
    },

    settle(results) {
      const people = results.map((r) => ({ name: r.name, c: cents(r.net) }));
      const transfers = [];
      for (;;) {
        let win = null, lose = null;
        for (const p of people) {
          if (p.c > 0 && (!win || p.c > win.c)) win = p;
          if (p.c < 0 && (!lose || p.c < lose.c)) lose = p;
        }
        if (!win || !lose) return transfers;
        const amt = Math.min(win.c, -lose.c);
        transfers.push({ from: lose.name, to: win.name, amount: amt / 100 });
        win.c -= amt;
        lose.c += amt;
      }
    },

    // One player's numbers across finished games ended at or after `since` (epoch ms). Names match case-insensitively.
    // Each result's play time is r.ms when recorded, else the game's duration.
    // series is oldest first: { at, net, total, game } per session, where game is the history record itself.
    playerStats(history, name, since = 0) {
      const key = String(name).trim().toLowerCase();
      const rows = history
        .filter((g) => (g.endedAt || 0) >= since)
        .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0))
        .flatMap((g) => (g.results || [])
          .filter((r) => String(r.name).trim().toLowerCase() === key)
          .map((r) => ({ at: g.endedAt || 0, net: cents(r.net), ms: Number(r.ms) || Number(g.duration) || 0, game: g })));
      let cum = 0, run = 0, bestStreak = 0;
      const series = rows.map((r) => ({ at: r.at, net: r.net / 100, total: (cum += r.net) / 100, game: r.game }));
      for (const r of rows) bestStreak = Math.max(bestStreak, (run = r.net > 0 ? run + 1 : 0)); // break-even ends a run
      const wins = rows.filter((r) => r.net > 0), losses = rows.filter((r) => r.net < 0);
      const avg = (arr) => (arr.length ? Math.round(sum(arr, (r) => r.net) / arr.length) / 100 : 0);
      const ms = sum(rows, (r) => r.ms);
      return {
        sessions: rows.length, net: cum / 100, wins: wins.length, losses: losses.length,
        winRate: rows.length ? wins.length / rows.length : 0, avgWin: avg(wins), avgLoss: avg(losses), avgNet: avg(rows),
        biggestWin: Math.max(0, ...rows.map((r) => r.net)) / 100, worstLoss: Math.min(0, ...rows.map((r) => r.net)) / 100, bestStreak,
        timeMs: ms, hourly: ms ? Math.round(cum / (ms / 3600000)) / 100 : 0,
        avgSessionMs: rows.length ? ms / rows.length : 0, series,
      };
    },

    // Headline numbers for one game record. rebuys is null for old records saved without results[].rebuys.
    gameStats(g) {
      const res = (g.results || []).slice().sort((a, b) => cents(b.net) - cents(a.net));
      const top = res[0], bottom = res[res.length - 1];
      return {
        players: res.length, pot: Number(g.pot) || 0, duration: Number(g.duration) || 0,
        rebuys: res.length && res.every((r) => Number.isInteger(r.rebuys)) ? sum(res, (r) => r.rebuys) : null,
        winner: top && cents(top.net) > 0 ? top : null,
        loser: bottom && cents(bottom.net) < 0 ? bottom : null,
      };
    },

    // Twelve monthly totals for `year`: a player's net when `name` is given, else the total pot played.
    monthly(history, year, name) {
      const key = name ? String(name).trim().toLowerCase() : null;
      const out = Array(12).fill(0);
      for (const g of history) {
        const d = new Date(g.endedAt || 0);
        if (d.getFullYear() !== year) continue;
        out[d.getMonth()] += key
          ? sum((g.results || []).filter((r) => String(r.name).trim().toLowerCase() === key), (r) => cents(r.net))
          : cents(g.pot);
      }
      return out.map((c) => c / 100);
    },

    // Every buy-in of a running game in time order, with the pot after it. `rebuy` is false for a player's first buy-in.
    potSeries(players) {
      let total = 0;
      return players
        .flatMap((p) => (p.buys || []).map((b, j) => ({ name: p.name, money: cents(b.money) / 100, at: Number(b.at) || 0, rebuy: j > 0 })))
        .sort((a, b) => a.at - b.at)
        .map((e) => ({ ...e, total: (total += cents(e.money)) / 100 }));
    },

    // Fun numbers for the live dashboard. `now` is epoch ms (for "the last hour").
    liveFacts(players, now = Date.now()) {
      const rows = players.map((p) => ({ name: p.name, rebuys: Math.max(0, (p.buys || []).length - 1), money: moneyCents(p) / 100 }));
      const rebuys = api.potSeries(players).filter((e) => e.rebuy);
      const king = rows.filter((r) => r.rebuys > 0).sort((a, b) => b.rebuys - a.rebuys || b.money - a.money)[0] || null;
      const deepest = rows.slice().sort((a, b) => b.money - a.money)[0] || null;
      const potC = sum(players, moneyCents);
      return {
        rebuys: rebuys.length,
        king,
        deepest,
        last: rebuys[rebuys.length - 1] || null,
        lastHour: sum(rebuys.filter((e) => now - e.at <= 3600000), (e) => cents(e.money)) / 100,
        avg: players.length ? Math.round(potC / players.length) / 100 : 0,
        out: players.filter((p) => Number.isFinite(p.count)).length,
      };
    },

    leaderboard(history) {
      const rows = new Map();
      const games = history.slice().sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
      for (const g of games) {
        for (const r of g.results || []) {
          const name = String(r.name).trim();
          const key = name.toLowerCase();
          let row = rows.get(key);
          if (!row) {
            row = { name, games: 0, wins: 0, losses: 0, net: 0, streak: 0, bestStreak: 0, bestNight: -Infinity };
            rows.set(key, row);
          }
          const c = cents(r.net);
          row.name = name; // latest spelling wins
          row.games++;
          row.net += c;
          if (c > 0) { row.wins++; row.streak = row.streak > 0 ? row.streak + 1 : 1; }
          else if (c < 0) { row.losses++; row.streak = row.streak < 0 ? row.streak - 1 : -1; }
          else row.streak = 0;
          row.bestStreak = Math.max(row.bestStreak, row.streak);
          row.bestNight = Math.max(row.bestNight, c);
        }
      }
      return [...rows.values()]
        .sort((a, b) => b.net - a.net || b.wins - a.wins || a.name.localeCompare(b.name, 'en'))
        .map((r) => ({ ...r, net: r.net / 100, avg: Math.round(r.net / r.games) / 100, bestNight: r.bestNight / 100 }));
    },

    // Re-sorts leaderboard rows: 'net' (most money), 'avg' (best player: 3+ games first, then by average per game) or 'games'.
    // Ties keep the leaderboard order (net, wins, name).
    rank(board, by = 'net') {
      const val = (r) => (by === 'games' ? r.games : by === 'avg' ? r.avg : r.net);
      return board.slice().sort((a, b) => (by === 'avg' ? (b.games >= 3) - (a.games >= 3) : 0) || val(b) - val(a));
    },
  };

  if (typeof module === 'object' && module.exports) module.exports = api; else root.PokerLogic = api;
})(this);
