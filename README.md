# WhatsApp Support Inbox

Mirrors an existing WhatsApp number — **the one that stays on the phone app** —
into a web inbox that ~10 support agents share. Every message appears in the UI
in both directions; agents reply from the UI; the phone keeps working exactly as
it does today.

```
  phone (primary, unchanged)
        │
        │  linked device
        ▼
  bridge/bridge.js ──HTTP(loopback)──► src/server.js ──► SQLite ──► browser UI
   (Baileys, mirror)                    ingest + gate + pacer        (SSE live)
```

**SQLite is the source of truth**, not WhatsApp. If the link dies you lose the
transport, never the history.

---

## Setup

```bash
npm install && npm install --prefix bridge
cp .env.example .env

# one per support agent
npm run user -- ali  "Ali Hassan" <password>
npm run user -- sara "Sara Khan"  <password>
```

### Linking the number (do this ONCE, on a laptop — not the server)

**WhatsApp blocks device-linking from datacenter IPs.** It does *not* block
*resuming* an already-linked session. So link on a trusted IP and hand the
finished session to the server.

```bash
npm run link          # on your laptop — prints a QR
```
Phone → **WhatsApp → Linked Devices → Link a device** → scan. Wait for
`✅ WhatsApp connected!`, then Ctrl-C.

That writes `auth_state/`. Zip it, copy it to the server's `auth_state/`, and the
server only ever resumes it. If the server ever prints "Scan this QR", the
session did not transfer — do not try to link on the server, it will fail with
"Try later".

### Running locally

```bash
npm run bridge     # terminal 1 — WhatsApp connection (must be the ONLY one)
npm start          # terminal 2 — inbox on http://localhost:8080
```

⛔ **Never run two bridge processes against one number.** Two clients fight over
the rotating session keys and WhatsApp force-logs-out the device. One systemd
unit, one process, always.

---

## Deploying on Coolify

Deploy as a **Docker Compose** resource from this repo; `docker-compose.yaml`
defines two services off one image. Give the public domain to `inbox` only —
`bridge` has no published port and must stay unreachable from outside.

**The volumes are the whole ballgame.** `data` holds `inbox.db` (all history)
and `auth_state` holds the WhatsApp session. Both are named volumes: without
them every push from GitHub wipes the conversation history *and* unlinks the
number. Never delete them during a redeploy.

### Environment (Coolify → Environment Variables)

| Variable | Value | Why |
|---|---|---|
| `BRIDGE_URL` | `http://bridge:3100` | Service name on the compose network |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | your choice | First-boot admin, see below |
| `TRUST_PROXY` | `1` | Coolify's proxy is one hop |

Everything in `.env.example` can be set the same way. Leave `FORCE_SECURE_COOKIE`
unset — with `TRUST_PROXY=1` and a Coolify-issued certificate the session cookie
gets `Secure` automatically.

### Seeding the WhatsApp session

Linking still happens on a laptop (`npm run link`) — WhatsApp blocks
device-linking from datacenter IPs. Copy the resulting `auth_state/` into the
`auth_state` volume before the first start:

```bash
docker cp auth_state/. <bridge-container>:/app/auth_state/
```

### Never scale either service

Both run exactly one replica. The bridge holds one WhatsApp session (two fight
and get the device logged out); the inbox runs the paced sender as a single loop
over the queue, so a second instance would send the same message twice and
double the rate the ban defences are tuned for.

### Redeploys

Redeploy must **stop the old container before starting the new one** (recreate,
not rolling). Two bridge processes on one number fight over the rotating session
keys and WhatsApp force-logs-out the device. Do not scale `bridge` past 1.

### Backups (Coolify → Scheduled Tasks)

```
npm run backup      # nightly
```

Writes `data/backups/inbox-<date>.db` (via `VACUUM INTO`, safe on a live WAL
database) and `auth_state-<date>.tar.gz`, keeping `BACKUP_KEEP_DAYS` (14).
That lands *inside* the `data` volume — pair it with a Coolify volume backup so
a lost server isn't a lost history.

---

## Users and passwords

One admin manages everyone. **Agents cannot change their own password** — a
forgotten password is a conversation with the admin, not a self-service reset
flow, so there is no email dependency and no reset-link surface.

- The admin is created on first boot from `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
  If that username already exists it is promoted to admin; its password is never
  overwritten by the environment.
- Admin tools live under the **profile menu** (top right): Team, Reports,
  WhatsApp connection — with Sign out last.
- **Team** — up to `MAX_TEAM` (15) seats including the admin. Add or remove
  members, reset one password, force-sign-out anyone currently signed in, or set
  one shared password for the whole team in a single action. A reset or a
  removal kills that person's open sessions immediately.
- Removing a member **deactivates** them: they can never sign in again and their
  seat is freed, but their past replies keep their name in the thread and in the
  reports. Nothing about the audit trail is rewritten.
- CLI equivalent, if you prefer a shell: `npm run user -- ali "Ali Hassan" <pw> [--admin]`.

Login is rate-limited: 5 failures against a username or an IP locks that
combination for 15 minutes. There is no unlock button — wait it out, or restart
the app, since the counters are in memory.

---

## Reports (admin)

Profile menu → **Reports**. Day-by-day table of customers responded to, replies
sent and agents active, plus each agent's share of the replies as a donut.
Filters: this week, this month, last month, or a custom range — capped at two
months, because past that the honest answer is an export, not a screen.

"Customers responded to" counts distinct chats an agent actually replied in,
which is what a shift is judged on — not raw message volume.

## Linking the phone from the UI (admin)

Profile menu → **WhatsApp connection** shows the linked number and lets an admin
unlink the device or link a new one, with the QR rendered in the browser. This
matters on Coolify, where there is no terminal to read a QR out of.

**Link a phone** clears the stored session before opening the socket. A QR is
only ever offered when there are no usable credentials — after a logout the dead
ones are still on disk, and Baileys would resume them and get a 401 instead of
ever showing a code. Only one socket runs at a time: two on one session get
closed with 440 (replaced) and can log the device out outright.

Unlinking is destructive: messages stop flowing until a phone is linked again.
The inbox keeps working read-only off SQLite in the meantime, and nothing in the
history is lost.

## Not getting banned

Bans are driven by recipient behaviour — blocks and reports — and by
burst/broadcast patterns. Almost all of it is outbound. So every outgoing
message passes `src/gate.js` before it reaches the wire:

| Rule | Default | Why |
|---|---|---|
| **Reply-only window** | 7 days since their last message | Cold outreach is the #1 ban driver. A contact who never wrote first can never be messaged at all. |
| Per-chat hourly cap | 15 | Rapid-fire to one person reads as a bot. |
| Team-wide hourly cap | 120 | Backstop against a runaway loop. |
| Duplicate-text guard | same text to 3 chats/24h | Identical bulk text is the broadcast signature that kills numbers. |
| Paced sender | 1 at a time, typing indicator, 3–8s jitter | An agent clearing 20 chats sends over minutes, not in one burst. |

**There is deliberately no bulk-send endpoint.** When someone asks for "message
all customers", the honest answer must be that the system cannot do it. That
request is what loses the number.

Tune the numbers in `.env` (loaded via `--env-file-if-exists`; on Coolify use the
Environment Variables UI instead).

**On `WINDOW_HOURS`:** Meta enforces a 24h service window on the *official*
Business API. This is a linked-device client, where WhatsApp enforces no window
at all — so the value is self-imposed ban insurance, set to 168 (7 days) so
agents can finish real conversations. What genuinely drives bans is messaging
people who never wrote to you, and that is blocked at every setting.

### Attachments

Agents attach a photo or document with the paperclip (or paste a screenshot
straight into the composer). The caption box is the normal reply box, so one
send carries the file and the text together.

Attachments go through **exactly the same gate as text** — reply window, hourly
caps, pacing. An image blasted to twenty chats is as much a broadcast as a
sentence is. A file rejected by the gate is deleted rather than left on disk.

Incoming **voice notes render as a player** — play/pause, a real waveform, the
duration and a seek bar — not as a file link. The waveform is decoded from the
actual recording, so it reflects the audio rather than decorating it. WhatsApp's
opus files make Chrome's media element fail over HTTP range requests, so each
file is fetched once and played from a blob; the same bytes feed the waveform.

`MAX_UPLOAD_MB` (default 16) caps the size. Images, video and audio are sent as
media; everything else goes as a document, which always arrives but isn't
previewed inline. Stored files are served only to signed-in agents, with
`nosniff`, and anything that isn't a known media type downloads instead of
rendering — an uploaded `.html` must never execute as script against the inbox.

### What the bridge does *not* do (so the phone stays usable)

- `markOnlineOnConnect: false` — the phone keeps its push notifications, and the
  account isn't permanently "online" (a bot signal).
- **No auto-read.** Blue ticks fire only when an agent actually opens the chat
  (`POST /read`). Auto-reading clears the phone's unread badges and tells the
  customer "read" when nobody read it.
- **Mirrors `fromMe`.** Replies typed on the phone appear in the UI, so agents
  don't double-answer.

### Also do these

- Put the phone on the **WhatsApp Business app** (same number, still on the
  phone, free). A business profile means fewer "who is this?" blocks.
- Replies go out as typed — the agent's name is **not** prefixed to the text the
  customer sees. Who sent what is recorded in `sent_by` and shown inside the
  inbox, which is what the reports are built from.
- Back up `auth_state/` nightly. It's the difference between a 10-minute
  recovery and an emergency relink.
- The phone must connect at least once every 14 days or all linked devices drop.

### When it gets banned anyway

It might. The data is in SQLite and the phone still works — the team falls back
to the handset while you re-link from a laptop. Keep a second number provisioned.
None of this is ToS-compliant; it is *unlikely to be actioned* and *survivable*.

---

## Names, numbers and LIDs

WhatsApp identifies group participants by a **LID** (`22402650091620@lid`), a
privacy id that is not a phone number. Three names can exist for one person:

| Source | Example | Where it comes from |
|---|---|---|
| Address-book name | `Ikram Dyer` | The linked phone's contacts, via Baileys' contact events |
| pushName | `ikram` | What the contact set for themselves |
| Phone number | `919414573208` | LID resolved through `auth_state/lid-mapping-*.json` |

The UI prefers them in that order and falls back to `+<number>`, which is what
the WhatsApp app itself does.

The address book lives in WhatsApp's *app state*, which is pushed unprompted
only when a device is first linked. A session linked on a laptop and copied to a
server therefore starts with no names at all. On its first run with an empty
cache the bridge clears the stored `critical_unblock_low` version and resyncs,
which replays every contact patch — `POST /contacts/resync` forces the same
thing later (e.g. after renaming someone on the phone). The bridge keeps the address book in
`data/contacts.json` and serves it at `GET /contacts`; the inbox mirrors it into
the `contacts` table every 5 minutes.

Group names come from WhatsApp's own group metadata, refreshed on a schedule —
never from whoever happened to message last. An unknown name is stored as NULL
and shown as the number/id, so a placeholder can never overwrite a real name.

The contact count is **people**, not index entries: each person is stored under
both their LID and their phone number so a lookup works whichever form a message
carries, which is why the raw entry count is roughly double.

Names resolve **retroactively** — they are joined at read time, not frozen into
each message row — so a contact learned today relabels every message that person
ever sent. A contact the phone has never saved still shows as a number.

## Finding and filtering conversations

The list has category chips — **All / Personal / Groups / Unassigned** — and a
date filter (today, last 7, last 30, or a custom range) on the search row. Both
filter the loaded list in the browser, so they are instant and combine with the
name/number search.

## How customers are identified

- Saved in the linked phone's contacts → **the name, and never the number**.
- Not saved → **the last 4 digits only** (`*** 1491`).

Only the address book counts as a name. WhatsApp also supplies a **pushName** —
what a person calls themselves — and that is *not* a saved contact: showing it
would identify someone the phone's owner never saved. It is masked like any
other unsaved number, in the list, the thread header and group sender labels
alike. Group subjects are unaffected.

Full numbers are deliberately kept off the screen, including in the thread
header and on group message senders.

## Message actions

Every message has a chevron, like WhatsApp's, opening **Reply / Forward / Copy**.

**Reply** quotes the message: the quote appears above the composer while you
type, travels with the message as a real WhatsApp quote (the customer sees the
bubble they replied to), and is rendered inside the thread afterwards. Quotes on
messages *from* customers are shown the same way. Attachments can be quoted too.

**Copy** puts the text on the clipboard, with a fallback for non-HTTPS origins
where the clipboard API is unavailable.

## Forwarding

Hover any message for a forward button, pick a conversation, done — text and
attachments alike. Forwarding runs the **same gate** as a normal reply: the 24h
window, the hourly caps and the duplicate-text guard all apply. Forwarding is
the easiest way to turn one message into a broadcast, so it gets no shortcut.

## Searching inside a conversation

The magnifier in the chat header opens a find bar: type to search **the whole
conversation's history**, step through matches with the arrows (Enter / Shift+Enter
too), and each hit is highlighted in place. **Jump to date** scrolls to the first
message on or after a chosen day.

A thread loads the newest 500 messages, so both features load a window centred on
the match or the date when it lies further back — history is never out of reach.

## Installing it on a phone

The inbox is installable as a home-screen app (manifest + icons + service
worker). **Android Chrome** offers an install prompt; **iOS Safari** has no
prompt of its own — Share → *Add to Home Screen* — but it then opens full
screen with the right icon and title rather than as a browser tab.

Requires HTTPS, which Coolify provides. On plain HTTP the service worker simply
does not register and the app works exactly as before.

**Only the shell is cached** — HTML, CSS, JS, icons. Conversations, media and
the event stream are never cached: showing an agent a stale thread they believe
is current is worse than showing nothing. Static assets are fetched
network-first so a deploy takes effect immediately, with the cache as the
offline fallback.

## How agents avoid mistakes

The UI is built around the four ways a shared inbox goes wrong:

1. **Two agents answer the same customer** → one owner per chat. Sending claims
   it; anyone else gets a blocked composer and an explicit *Take over from Ali*
   button. Claims auto-release after 2h idle so nobody is stuck.
2. **A reply is written and then rejected** → the composer is disabled *before*
   typing, with the reason, whenever the window is closed or someone else owns
   the chat. The header shows the live countdown (`6h 12m left`).
3. **A message silently fails** → every outbound message is on the timeline from
   the moment it's queued: `🕓 queued → 🕓 sending → ✓ sent`, or a red
   `⚠ <error>` with **Retry**. A rejected send leaves the text in the box.
4. **Nobody notices WhatsApp dropped** → the header shows live link status.

## Files

| Path | Purpose |
|---|---|
| `bridge/bridge.js` | Baileys client in mirror mode (from the Deone project, retuned) |
| `src/db.js` | Schema + queries. `node:sqlite`, no DB dependency |
| `src/gate.js` | Outbound gate and paced sender — the ban defence |
| `data/contacts.json` | Bridge's address-book cache (survives restarts) |
| `src/server.js` | API, SSE fan-out, ingest loop |
| `src/auth.js` / `src/adduser.js` | scrypt sessions, login lockout, admin role |
| `src/backup.js` | `npm run backup` — DB + auth_state, prunes old copies |
| `Dockerfile` / `docker-compose.yaml` | Coolify deployment, one image, two services |
| `public/` | The UI. Vanilla, no build step |
| `src/gate.test.js` | `npm test` — the gate rules |
