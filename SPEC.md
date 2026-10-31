# Kongens Nytorv Home Games — build spec

A home poker game tracker in the style of the Poker Tally app: a near-black background, neon green, rounded type (Nunito), bottom tabs, and sheets with a number keypad.
There is a light theme too (see **Theme**).
It runs on localhost on the host's laptop (the folder is still called "Poker Night"). Run it with `python3 serve.py` or `Start Poker Night.command`, then open http://localhost:8787.

## Files
- `index.html`: markup, `<style>`, and `<template>`s. The wrapper tags each sit on their own line, so they can be stripped for a claude.ai publish later.
- `logic.js` + `logic.test.js`: pure math, global `PokerLogic`. Run `node --test logic.test.js`.
- `store.js` + `store.test.js`: saving the game and history, global `PokerStore`. Run `node --test store.test.js`.
- `app.js`: screens and flow.
- `serve.py`: local server with caching off.

## Screens
**Tabs** (bottom bar):
- **Home**
  - "Your results in <year>" when Profile says who you are, otherwise "Played in <year>".
  - Six-month bar chart.
  - Latest sessions: a LIVE card for the running game, then past games. Tap a card to open its results.
  - Ideas for your next home game.
  - A green + button starts a new game, or reopens the running one.
- **Leaderboard** (players)
  - Rank by: "Most money" (all-time net), "Best player" (average result per game, players with 3+ games first, then the rest) or "Most games".
  - A podium for the top 3, then the rest ranked with games, wins and current streak, then saved players with no games yet.
  - Add a player. × forgets a saved player who has no games yet (anyone can also be forgotten from the add sheet).
  - Tap a player to open their page.
- **Stats**
  - Period: this year, all time, or the last 30 days. Player: all, or one.
  - **One player:** total profit with a running-total chart, sessions, hourly profit, time played, avg win, avg loss, avg session length, win rate.
  - **All players:** sessions, total pots, avg pot, biggest pot, time played, players, and the leaderboard (tap a player to open their page).
- **Profile**
  - "That's me" (drives Home), default currency, default buy-in, "Open table screen", and the theme toggle.

**Player page** (from the leaderboard or the Stats leaderboard):
- Avatar, name, games and time at the table.
- Total won/lost, and a big running-total line chart: starts at 0, a green segment after a winning game, red after a losing one, a dot per game, and a green/red gradient area down to the zero line. Hover or tap a dot for that game's date, name, result and running total.
- Tiles: games played, wins, win rate, biggest win, worst loss, best streak (wins in a row), avg per game, hourly, time played.
- Their games, newest first. Tap one to open its dashboard; Back returns to the player page.

**New game:**
- Currency pill.
- Big buy-in amount. Tap it for the keypad; changing it also updates players still at the old amount.
- Game name (defaults to "<Weekday> game").
- Bomb pots: off, or every 15/20/30/45/60 min.
- Players: + opens the add sheet, with a name box and saved-player chips. Tap a player's amount to change their buy-in, × to remove them.
- Start game needs at least 2 players.

**Live game:**
- Header: back, game name, player count, and ⋯ for game settings.
- Stats card: total buy-ins, in play (buy-ins minus cash-outs), and duration (the clock).
- Bomb pot countdown. "Bomb pot now!" beeps; Done sets up the next one.
- Players as avatar circles. Tap one for Rebuy or Cash out; cashed-out players turn pink.
- + adds a late player: name, then their buy-in on the keypad.
- Activity: every buy-in, rebuy and cash out with its time, filterable by player. Tap one to edit its amount or delete it. Deleting a cash out puts the player back in the game; deleting someone's only buy-in removes them.
- Dock: Cash out and Rebuy, each asking who first.
- Cash out uses a pink keypad, with the whole table listed above it (everyone's buy-in and cash-out so far).
- When everyone has cashed out, a "See results" box appears. It only works when the cash-outs equal the buy-ins; otherwise it says how much is short or over.
- Game settings: name, currency, bomb pots, pause/resume clock, open table screen, "End game: cash out everyone" (goes through the remaining players one by one), and delete game (two taps).

**Game dashboard** (results): shown when a game ends, and when a past game is opened from Home or a player page.
- Headline tiles: total pot, players, duration, rebuys ("–" for older games saved without rebuy counts), biggest winner and biggest loser.
- A bar chart of each player's +/−: green bars up and red bars down from a zero line, the amount at each bar and the name underneath (amounts are left off with 10+ players).
- A card with the game name, duration, everyone's +/−, settlements (fewest payments) and the date.
- "Save results as an image" downloads a PNG in the current theme's colors. "Copy results as text" is for pasting into a group chat.

**Charts** are hand-written SVG (no chart library), drawn at the element's pixel size and redrawn on resize. They draw in with a short animation (the line wipes in, bars grow), which `prefers-reduced-motion` turns off.

**Theme:** dark (the original look) and light (off-white page, white cards, near-black text, deeper green/red/pink with at least 4.5:1 contrast). Every color is a CSS token on `:root`, overridden by `:root[data-theme="light"]`.
- A sun/moon button on the Home header and a row in Profile switch it in one tap. The icon shows the theme you switch to.
- The choice is saved in localStorage `pokerNight.theme` (`"light"` / `"dark"`). With nothing saved it follows the system setting, including live changes.
- A small script in `<head>` sets `data-theme` before the first paint; other open windows (the table screen) follow through the `storage` event.

**Table screen** (`#table`):
- A big read-only view for a second window or a TV: clock, bomb countdown, buy-ins, in play, players, then results when done.
- Live sync through the `storage` event.

The keypad accepts laptop keys too: digits, `.` or `,`, Backspace, Enter, Esc.
Chips are worth their face value, so a cash-out is the money in front of the player.

## Data

**Game state.** localStorage `pokerNight.game.v2` (db doc `games/current` when hosted):
```js
{
  phase: "none" | "setup" | "live" | "done",
  name: "Saturday game", currency: "DKK",   // DKK, USD, EUR, GBP, SEK, NOK or CHIPS
  buyIn: 200, bombEvery: 30, bombsDone: 0,
  players: [ { name, buys: [ { money, at } ], count: null | cashOutAmount, outAt: null | ms } ],
  elapsed: 0, since: null, startedAt: null,   // the clock: elapsed ms while paused + start of the running stretch
  result: null                                // the GameRecord once phase === "done"
}
```

**GameRecord.** localStorage `pokerNight.history.v2` as an array (db collection `history` when hosted):
```js
{ name, currency, endedAt, startedAt, duration, pot,
  results: [ { name, in, out, net, ms, rebuys? } ],   // sorted by net desc; ms = that player's time at the table
                                                     // rebuys = buy-ins after the first; optional, older records don't have it
  transfers: [ { from, to, amount } ] }
```

**Other keys:**
- Prefs: `pokerNight.prefs.v1` = `{ me, currency, buyIn }`.
- Saved players: `pokerNight.profiles.v1` = `[{ name }]`. Every name added to a game is saved.
- Theme: `pokerNight.theme` = `"light"` or `"dark"` (a plain string, not JSON). Missing means follow the system.

## PokerLogic
- `money`, `totals` → `{ money, buys }`. `fmtTime`, `fmtMoney`, `fmtNet`.
- `cashOut(players)` → `{ ok, counted, pot, diff, results }`. `out` = count at face value, and `ok` when the counts equal the pot in cents.
- `settle(results)` → the fewest transfers.
- `leaderboard(history)` → per player: games, wins, losses, net, avg (net per game), current streak, best streak, best night.
- `rank(board, by)` → leaderboard rows re-sorted by `'net'`, `'avg'` (3+ games first) or `'games'`; ties keep the leaderboard order.
- `playerStats(history, name, since)` → sessions, net, wins, losses, winRate, avgWin, avgLoss, avgNet, biggestWin, worstLoss, bestStreak, timeMs, hourly, avgSessionMs, and a series (oldest first) of `{ at, net, total, game }`, where `game` is the history record.
- `gameStats(record)` → players, pot, duration, rebuys (null when not recorded), winner and loser (the result rows, or null when nobody won or lost).
- `monthly(history, year, name?)` → 12 monthly totals: the player's net, or the total pot.

## Later (not built)
- An invite link so players add their own rebuys from their phones. It needs shared online storage (the hosted claude.ai db path in store.js, or a backend like Supabase). Saved players and stats move there too.
- A shareable results link.

## Online (GitHub Pages + Supabase)
- Live at https://yoyobread2431.github.io/kongens-nytorv/ (repo `Yoyobread2431/kongens-nytorv`; publish = commit + push). With `online/config.js` present the app is online; without it, it's laptop-only as before.
- Backend: Supabase project `ypsbdlnsfwyhifkfpawp`. Tables, privacy rules and invite functions are in `online/schema.sql`; the online store is `online/store-online.js` (`PokerOnline`, same contract as `PokerStore`). See `online/INTEGRATION.md`.
- Sign-in: email + password (Supabase "Confirm email" off, no email is sent). Profile has Set password, My stats and games, Sign out.
- The host (emails in the `admins` table) runs games and makes invite links (Invite players). Friends open `#join=CODE`, create an account, pick "Which one are you?", and from then on watch live games and see their own stats and the leaderboard. They can't change anything.
- Invites: "Invite players · show QR code" (live screen, setup, ⋯ menu) opens a sheet with a QR code (qrcode-generator from cdnjs), the link, Copy and Share. The TV screen shows a "Scan to follow the game" QR while a game is set up or live.
- Publishing: run `./publish.sh "What changed"`. It stamps `?v=` on the script tags (GitHub Pages caches files for 10 minutes; the stamp keeps old and new files from mixing), commits and pushes.
- Online store robustness: an unconfirmed host check means "unknown" (saves wait), a failed save is sent again on the next load/reconnect, and a finished game stays on screen after a reconnect.
