# Wiring PokerOnline into the app (for the lead)

`online/` is self-contained: `schema.sql`, `store-online.js` (global `PokerOnline`), `store-online.test.js` (`node --test online/store-online.test.js`), `config.example.js`. Nothing in `index.html`, `app.js`, `logic.js` or `store.js` has been touched.

## 1. Script tags and config

In `index.html`, after `store.js` and before `app.js`:

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/dist/umd/supabase.js"
        integrity="sha384-BWcjm9OdFth9TbhCxZPdm+gAOUMAzQy9nmTs12ioXdCcbVnJaPMn+fMUoQCLt60R" crossorigin="anonymous"></script>
<script src="online/config.js"></script>          <!-- missing file = offline mode, as today -->
<script src="online/store-online.js"></script>
```

- `online/config.js` is a copy of `config.example.js` filled with the project URL and the publishable (or legacy anon) key. Commit and publish it: GitHub Pages needs it, and both values are public by design. Never put the secret/service_role key there.
- 2.117.3 instead of 2.45.4 on purpose: new projects issue `sb_publishable_…` keys, which the 2024 client predates. It was released on 2026-10-07, the hash above was taken from jsDelivr today, and the real UMD build was smoke-tested against this store.

## 2. Picking the store

```js
const ON = window.PokerOnline && PokerOnline.configured ? PokerOnline : null;
const S = ON ? ON.store : PokerStore;   // same { mode, init, saveGame, addGame } contract
```

`PokerOnline.store` keeps `PokerStore`'s contract: `init({ onGame, onHistory, onStatus })` fires `onGame` and `onHistory` right away from the device cache (`kn.online.*` keys, separate from `pokerNight.*`). It then loads from the server and follows Realtime. `addGame` returns a promise that rejects on failure, and `onStatus` only fires on change. `mode` is `'local'`, then `'shared'` once a signed-in user connects.

The store binds to the signed-in user at `init`, so **reload the page after sign-in, sign-out, or a successful claim**.

## 3. Boot flow

```js
let host = !ON, me = null;            // offline laptop = host, as today
if (!ON) startApp();
else {
  let first = true;
  ON.onAuth(async (user) => {          // once with the current user, then on every real change
    if (!first) return location.reload();
    first = false;
    if (!user) return showSignIn();
    [host, me] = await Promise.all([ON.isAdmin(), ON.myPlayer()])
      .catch(() => [false, null]);     // offline: view-only until a reload (or cache `host` yourself)
    const code = joinCode();           // #join=CODE, or ?join=CODE after the email round-trip
    if (code && !me && !host) return showJoin(code);
    if (!host && !me) return showSignedInButNotInvited(); // "Ask the host for an invite link"
    startApp();                        // S.init(...) as today
  });
}
const joinCode = () => (location.hash.match(/^#join=([A-Za-z0-9]+)/) || location.search.match(/[?&]join=([A-Za-z0-9]+)/) || [])[1] || null;
```

**Sign-in screen:** an email box and an "Email me a sign-in link" button, then a "Check your email" message.

```js
const code = joinCode();
await ON.signIn(email, location.origin + location.pathname + (code ? `?join=${code}` : ''));
```

The code goes in `?join=`, not the hash, because Supabase returns the session in the URL hash after the magic link. Show `e.message` on failure. Supabase's own messages are readable, for example its 60-second resend limit.

**Join screen (`#join=CODE`):** first `const g = await ON.gameByCode(code)`.
- `null` means "This invite link doesn't work. Ask the host for a new one."
- Otherwise show "Which one are you?" with `g.name`, and one button per `g.players` entry. A `claimed: true` entry is greyed out and marked "taken".
- Add an "I'm not on the list" option with a name box (1 to 30 characters).
- On pick, call `await ON.claim(code, name)`. Then clear the code with `history.replaceState(null, '', location.pathname)` and `location.reload()`.
- On error, show `e.message` (already plain English). `e.code` is one of `taken`, `bad_code`, `bad_name`, `signed_out` or `failed`. On `taken`, refresh the list.

## 4. Host controls and player mode

When `!host`, the app is a viewer, like a phone version of `#table`:
- **Hide:** the + button (new game), Rebuy/Cash out dock, late-player +, tapping avatars, activity edits, the ⋯ game menu, keypads, Finish/"See results", Add player and × on the leaderboard, and the "That's me" picker.
- **Keep:** Home, Leaderboard, Stats, player pages, the live game (read-only, updating via Realtime) and the results dashboard (image and text export are fine).
- **Never call `S.saveGame` or `S.addGame` in player mode.** That includes `leaveResults` (just reset local `state`). The store refuses them anyway and sets the status "Only the host can change the game." (`addGame` rejects).

**Host extras:** an **Invite** button in the live/setup header or the ⋯ menu:

```js
const code = await ON.inviteCode();   // null until the game's first save reaches the server
if (!code) return flash('Saving… try again in a moment');
const url = location.origin + location.pathname + '#join=' + code;
navigator.share ? navigator.share({ title: 'Kongens Nytorv Home Games', url }) : navigator.clipboard.writeText(url);
```

## 5. "My account"

The signed-in player's account is their player page:
- Set `prefs.me = me.name` (no picker), so Home shows "Your results in <year>".
- Make the Profile tab open the existing player page for `me.name` (`playerStats(history, me.name)`: results, games played, the running-total chart, tiles, their games).
- Add the signed-in email (`(await ON.user()).email`), the theme toggle, and **Sign out**: `ON.signOut().then(() => location.reload())`. `signOut` also clears the `kn.online.*` cache.
- The host gets the same page if they claimed a player, plus the existing currency and buy-in defaults.

## 6. Behaviour worth knowing

- **Current game:** the newest `setup`/`live` row. `saveGame` with phase `setup`/`live`/`done` upserts it. Phase `none` deletes the row if it never finished (the app's "delete game"), and keeps it if it's done (leaving the results screen).
- **Finished games are never reopened.** After `done`, the next `setup` save starts a new row, and the database refuses `done → live` (SQLSTATE `KN423`).
- **Viewers see the results when the host finishes.** They keep seeing them until the host starts the next game. After a reload, a finished game is no longer "current", so it's found in history.
- **The `storage`-event sync between windows is replaced by Realtime.** The `#table` window updates through Realtime.
- **Two hosts editing at once:** the last write wins, the same as the shared path in `store.js`. Edits waiting to be saved always beat incoming changes.
- **Offline:** an unsaved game stays on the device and is pushed on the next successful load, if this user is a host.
- **Status messages:**
  - "Sign in to see your games."
  - "Online sync is not set up."
  - "Can't reach saved games right now. Showing this device's copy."
  - "Couldn't save. Check your connection."
  - "Only the host can change the game."

## 7. PokerOnline API

| Member | Returns |
|---|---|
| `configured` | `true` when `window.KN_CONFIG` has `url` and `anonKey` |
| `signIn(email, redirectTo)` | sends the magic link (`signInWithOtp`); rejects on error |
| `signOut()` | signs out and clears the online cache |
| `onAuth(cb)` | `cb(user or null)` once, then on each user change; returns an unsubscribe function |
| `user()` | the signed-in Supabase user, or `null` |
| `isAdmin()` | `true` for hosts (emails in `admins`) |
| `myPlayer()` | `{ id, name, user_id }`, or `null` before claiming |
| `claim(code, name)` | the player row; errors carry `.code` |
| `gameByCode(code)` | `{ name, status, players: [{ name, claimed }] }`, or `null` |
| `inviteCode()` | the current game's 8-character code, or `null` |
| `store` | `{ mode, init, saveGame, addGame }`, the same contract as `PokerStore` |
