# Putting Kongens Nytorv Home Games online

> **Current sign-in method (2026-10-31): email + password, no email is ever sent.** The Gmail step below was dropped:
> the host didn't want their personal Gmail involved. In Supabase, Authentication → Sign In / Providers → Email → **Confirm email** is OFF,
> and custom SMTP is off. Friends tap Create account (email + a password they choose), then pick their name. The host resets a forgotten
> password in Supabase → Authentication → Users. Ignore the magic-link and Gmail sections below unless email sign-in comes back.


This gets the poker tracker onto the internet, so your friends can open it on their phones and see their own results, the leaderboard and the live game. You're the host: only you can change games. Friends can only look.

It uses two free services:
- **Supabase** stores the games and handles sign-in.
- **GitHub Pages** hosts the app at https://yoyobread2431.github.io/kongens-nytorv/.

There are no passwords. People sign in with a link that gets emailed to them.

---

## 1. What Claude does for you

Once your free personal Supabase organization exists, Claude uses the Supabase connector to:

1. Create a new project (for example "kongens-nytorv") in **your personal organization**, on the free plan, in an EU region close to Copenhagen. It never touches the Capito Capital organization or its projects.
2. Set up the database by applying `online/schema.sql`. That creates the tables for players, games and hosts, plus the rules for who can see and change what.
3. Add your email address as the host, so your account can run games.
4. Copy the project's address and its public key into `online/config.js`. Both are meant to be public: every visitor's browser gets them, and the database rules protect the data.
5. Run Supabase's security check on the new project.

You don't need to type any code. Steps 2 and 3 below are clicks in two websites.

---

## 2. Let Supabase send sign-in emails from your Gmail

Supabase's built-in email only reaches people on your Supabase team, so your friends would never get their sign-in links. The fix is to send them from your Gmail.

**a) Make a Gmail app password.** This is a separate 16-letter password that only lets Supabase send email. It is not your normal Gmail password.

1. Make sure 2-Step Verification is on for your Google account. Check at https://myaccount.google.com/security.
2. Go to https://myaccount.google.com/apppasswords.
3. Type a name like `Supabase poker` and click **Create**.
4. Copy the 16-letter password Google shows you. You only see it once.

**b) Put it into Supabase.** In your new project, go to **Authentication → Emails → SMTP Settings** (newer dashboards may call it "Custom SMTP"). Turn on **Enable custom SMTP** and fill in:

| Field | What to type |
|---|---|
| Sender email | your full Gmail address |
| Sender name | `Kongens Nytorv Home Games` |
| Host | `smtp.gmail.com` |
| Port | `465` |
| Username | your full Gmail address |
| Password | the 16-letter app password (without spaces) |

Click **Save**.

Two optional extras:
- **Authentication → Rate Limits:** Supabase limits how many emails it sends per hour. If a lot of friends sign in on the same evening, raise "emails per hour" to around 30.
- Gmail lets you send roughly 500 emails a day, which is far more than you'll need.

Keep the app password private. Never paste it into the app's files or a chat. If it leaks, delete it on the app passwords page and make a new one.

---

## 3. Tell Supabase where the app lives

In Supabase, go to **Authentication → URL Configuration**:

- **Site URL:** `https://yoyobread2431.github.io/kongens-nytorv/`
- **Redirect URLs:** click **Add URL** and add both of these:
  - `https://yoyobread2431.github.io/kongens-nytorv/**`
  - `http://localhost:8787/**`

The `**` at the end matters. It lets the sign-in link take a friend straight back to the right invite. The localhost line is so the app also works on your laptop.

While you're in Authentication, check **Sign In / Providers → Email**. "Confirm email" should stay **on** (it is by default). It stops anyone from signing in as someone else's email address.

---

## 4. How inviting friends works

**You (the host):**
1. Sign in on your laptop with the email you gave Claude as the host email.
2. Start a game as usual, and add the players.
3. Tap **Invite** and send the link to the group chat. It looks like `https://yoyobread2431.github.io/kongens-nytorv/#join=K7MPX3QD`.

**Each friend:**
1. Opens the link and types their email.
2. Gets an email from "Kongens Nytorv Home Games" and taps the link in it. That brings them back to the app, signed in.
3. Sees "Which one are you?" with the game's players, taps their own name (or types it if they're new), and that's it.

From then on, a friend just opens the app on their phone. They see their own results, games played, their profit graph, the leaderboard and the live game, updating as you enter rebuys and cash outs. They can't change anything.

**Good to know:**
- Each name can only be picked by one person. Whoever picks it first gets it. Pick your own name early too. If someone picks the wrong name, ask Claude to free it up.
- An invite link keeps working after its game ends, so a friend can join later from an old link. Anyone you forward a link to can join, so only share it with the group.
- Signing in on a new phone is the same: type your email and tap the link.
