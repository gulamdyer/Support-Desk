/** Shared WhatsApp inbox — HTTP server, ingest loop and SSE fan-out. */
import express from 'express';
import path from 'node:path';
import { existsSync, statSync, statfsSync, readdirSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import S, { recordInbound, now, db, contactChanged } from './db.js';
import { login, logout, requireAuth, requireAdmin, requireOwner, hashPassword, seedAdmin, publicUser, LoginError } from './auth.js';
import { queueReply, queueMedia, windowState, checkOutbound, runSender, GateError } from './gate.js';
import { isOci, quotaBytes, saveMedia, openMedia, removeMedia, ociUsage,
  listObjects, getObject, BACKUP_PREFIX } from './media-store.js';

// Same reasoning as the bridge: an async stream error (a media fetch dying
// mid-flight) is emitted where no try/catch can see it, and would otherwise
// take the whole inbox down and disconnect every agent's live stream.
process.on('uncaughtException', (err) => console.error('uncaught (staying up):', err?.stack || err));
process.on('unhandledRejection', (err) => console.error('unhandled rejection (staying up):', err?.stack || err));

const PORT = Number(process.env.PORT || 8080);
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:3100';
const MEDIA_DIR = path.resolve('data', 'media');
// Mirrors db.js exactly, so a staged restore lands where the next boot looks.
const DB_FILE = process.env.DB_PATH || path.resolve('data', 'inbox.db');
const CLAIM_TTL = 2 * 3600; // an untouched claim is released so nobody is blocked
const PLACEHOLDER_BODY = /^\[(image|audio|video|document|sticker|media) received\]$/i;
const realBody = (b) => (PLACEHOLDER_BODY.test(b || '') ? '' : (b || ''));

const MAX_TEAM = Number(process.env.MAX_TEAM || 15); // seats for the customer's team; the owner account does not use one
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 16); // WhatsApp itself balks well before this

// Extension decides how WhatsApp renders it. Anything unlisted goes as a document,
// which is the safe default: it always arrives, it just isn't previewed inline.
const MEDIA_KINDS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
  video: ['mp4', 'mov', '3gp', 'mkv', 'webm'],
  audio: ['mp3', 'ogg', 'opus', 'm4a', 'aac', 'wav'],
};
const kindOf = (ext) =>
  Object.keys(MEDIA_KINDS).find((k) => MEDIA_KINDS[k].includes(ext)) || 'document';

async function bridge(route, body) {
  const res = await fetch(BRIDGE_URL + route, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  } : { signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    // This message is stored on failed messages and shown in the thread, so it
    // must read as something an agent can act on — not as internal plumbing.
    console.error(`bridge ${route}: ${res.status} ${await res.text().catch(() => '')}`);
    throw new Error(res.status === 503
      ? 'WhatsApp is not connected right now. The message stays queued.'
      : 'WhatsApp did not accept that. Try again in a moment.');
  }
  return res.json();
}

// --- SSE fan-out --------------------------------------------------------
const clients = new Set();
function broadcast(event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) { try { res.write(frame); } catch { clients.delete(res); } }
}

// --- ingest: bridge queue -> SQLite -> browsers --------------------------
let bridgeStatus = 'starting';
async function ingest() {
  for (;;) {
    try {
      const msgs = await bridge('/messages');
      // Written synchronously on receipt: SQLite is the durable record from here.
      for (const m of msgs) if (recordInbound(m)) broadcast({ type: 'message', message: S.message.get(m.messageId) });
      if (msgs.length) broadcast({ type: 'chats' });
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

// The bridge learns the address book from WhatsApp; SQLite is where the UI
// reads it. Names resolve retroactively, so a contact learned today relabels
// every message that person ever sent.
/** Group names come from WhatsApp, not from whoever happened to message last.
 *  Pulled on a schedule so a name is never left as a raw id. */
async function syncGroupNames() {
  try {
    const { groups } = await bridge('/groups');
    for (const g of groups || []) {
      if (g.id && g.subject) S.setChatName.run(g.subject, g.id, g.subject);
    }
  } catch { /* not connected yet; the next pass picks it up */ }
}

async function syncContacts() {
  for (;;) {
    try {
      S.dropExpiredSessions.run(now() - 12 * 3600); // not just at boot
      await syncGroupNames();
      const list = await bridge('/contacts');
      if (Array.isArray(list) && list.length) {
        // Skip anything already stored with the same name and number. The whole
        // address book arrives on every pass, so without this each tick rewrites
        // thousands of identical rows and bumps updated_ts for no reason.
        const have = new Map(S.contactsAll.all().map((r) => [r.key, r]));
        const fresh = list.filter((c) => contactChanged(have.get(c.key), c));
        if (fresh.length) {
          const t = now();
          db.exec('BEGIN');
          try {
            for (const c of fresh) S.upsertContact(c.key, c.lid ?? null, c.phone ?? null, c.name ?? null, c.notify ?? null, t);
            db.exec('COMMIT');
          } catch (e) { db.exec('ROLLBACK'); throw e; }
          broadcast({ type: 'chats' });
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300000)); // 5 min; the address book barely moves
  }
}

async function watchBridge() {
  for (;;) {
    let next = 'unreachable';
    try { next = (await bridge('/health')).status; } catch {}
    if (next !== bridgeStatus) {
      bridgeStatus = next;
      broadcast({ type: 'status', status: next });
      // The link itself completes on the bridge, so this poll is where the
      // inbox first learns of it. Only record a genuinely new number: a
      // redeploy reconnects the same phone and must not fill the history.
      if (next === 'connected') {
        try {
          const { number } = await bridge('/link/status');
          const last = S.lastWaEvent.get();
          if (number && !(last?.kind === 'linked' && last.detail === number)) logWa('linked', number);
        } catch { /* the next poll will catch it */ }
      }
    }
    S.releaseStale.run(now() - CLAIM_TTL);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

// --- HTTP ---------------------------------------------------------------
const app = express();
// Coolify terminates TLS at its proxy and forwards over plain HTTP, so the real
// scheme and client IP arrive in X-Forwarded-*. Without this the cookie never
// gets Secure and every login rate-limits against the proxy's single IP.
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
// One parser per size class. A single global 1mb parser would reject uploads
// before the route ever saw them; a single large one would let any endpoint be
// used to push 32mb through the process.
const jsonSmall = express.json({ limit: '1mb' });
const jsonUpload = express.json({ limit: `${MAX_UPLOAD_MB * 2}mb` }); // base64 inflates by ~4/3
app.use((req, res, next) =>
  (req.method === 'POST' && req.path.endsWith('/media') ? jsonUpload : jsonSmall)(req, res, next));
// Express 4 does not catch rejections from async handlers; without this an
// await that throws takes the whole process down instead of returning a 500.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// There is no build step, so filenames are not content-hashed and a long
// browser cache pins people to an old build after every deploy. The shell
// revalidates instead — the ETag makes the usual answer a 304 with no body —
// while icons, which effectively never change, may sit in cache for a day.
//
// sw.js is the one that must never be cached: a stale service worker keeps
// serving a stale app and cannot be corrected by shipping anything new.
const REVALIDATE = /(?:sw\.js|index\.html|app\.js|style\.css|manifest\.webmanifest)$/;
app.use(express.static(path.resolve('public'), {
  etag: true,
  setHeaders(res, filePath) {
    res.setHeader('Cache-Control', REVALIDATE.test(filePath) ? 'no-cache' : 'public, max-age=86400');
  },
}));

// FORCE_SECURE_COOKIE=false only for a bare-HTTP LAN deployment; the cookie is
// then sniffable, which is exactly what the flag is admitting.
const secureCookie = (req) => process.env.FORCE_SECURE_COOKIE !== 'false'
  && (req.secure || process.env.FORCE_SECURE_COOKIE === 'true');
const sessionCookie = (req, token, maxAge = 43200) =>
  `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}` + (secureCookie(req) ? '; Secure' : '');

// Unauthenticated on purpose: Coolify's health check runs before anyone logs in.
// Public (the platform health check runs before anyone signs in), so it says
// only that the process is alive — the connection state is for signed-in eyes.
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.post('/api/login', wrap(async (req, res) => {
  let out;
  try {
    out = await login(req.body?.username, req.body?.password, req.ip);
  } catch (err) {
    if (err instanceof LoginError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
  if (!out) return res.status(401).json({ error: 'Wrong username or password.' });
  res.setHeader('Set-Cookie', sessionCookie(req, out.token));
  res.json({ user: out.user });
}));

app.post('/api/logout', requireAuth, (req, res) => {
  logout(req.token);
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => (req.path === '/login' ? next() : requireAuth(req, res, next)));

app.get('/api/me', (req, res) => res.json({ user: req.user, whatsapp: bridgeStatus }));

app.get('/api/chats', (req, res) => res.json({ chats: S.chatList.all(), whatsapp: bridgeStatus }));

// --- admin: user management ---------------------------------------------
// Agents cannot change their own password by design: one admin holds the
// resets, so a forgotten password is a conversation, not a self-service flow.
const MIN_PW = 8;

app.get('/api/admin/users', requireAdmin, (req, res) =>
  res.json({ users: S.userList.all(), seats: { used: S.activeCount.get().c, max: MAX_TEAM } }));

app.post('/api/admin/users', requireAdmin, wrap(async (req, res) => {
  const username = String(req.body?.username || '').toLowerCase().trim();
  const name = String(req.body?.name || '').trim();
  const password = String(req.body?.password || '');
  if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
    // Say what to type, not which characters failed a pattern.
    const suggestion = username.replace(/[^a-z0-9._-]+/g, '.').replace(/\.{2,}/g, '.').replace(/^[._-]+|[._-]+$/g, '').slice(0, 32);
    return res.status(422).json({
      field: 'username',
      error: suggestion.length >= 2 && suggestion !== username
        ? `A username is a sign-in name, so it cannot contain spaces. Try "${suggestion}".`
        : 'A username is 2-32 characters: letters, digits, dot, underscore or hyphen.',
    });
  }
  if (!name) return res.status(422).json({ field: 'name', error: 'Enter the person\'s full name — this is what the team sees.' });
  if (password.length < MIN_PW) return res.status(422).json({ field: 'password', error: `Use at least ${MIN_PW} characters.` });
  if (S.userByName.get(username)) return res.status(409).json({ field: 'username', error: `"${username}" is already taken — pick another username.` });
  if (S.activeCount.get().c >= MAX_TEAM) {
    return res.status(409).json({ error: `The team is full (${MAX_TEAM} seats). Remove someone first.` });
  }
  S.addUser.run(username, name, await hashPassword(password), now(), req.body?.is_admin ? 1 : 0);
  res.json({ user: publicUser(S.userByName.get(username)) });
}));

app.post('/api/admin/users/:id/password', requireAdmin, wrap(async (req, res) => {
  const user = S.userById.get(Number(req.params.id));
  const password = String(req.body?.password || '');
  // 404, not 403: the owner account is not listed, so it must not be
  // discoverable by probing ids either.
  if (!user || user.is_owner) return res.status(404).json({ error: 'No such user.' });
  if (password.length < MIN_PW) return res.status(422).json({ field: 'password', error: `Use at least ${MIN_PW} characters.` });
  S.setPassword.run(await hashPassword(password), user.id);
  S.dropUserSessions.run(user.id); // the old password's sessions die with it
  res.json({ ok: true, signedOut: true });
}));

app.get('/api/chats/:id', (req, res) => {
  const chat = S.chat.get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  // ?around=<unix ts> loads a window centred on that moment instead of the tail,
  // which is what a date jump or a hit in old history needs.
  const around = Number(req.query.around);
  const messages = Number.isFinite(around) && around > 0
    ? [...S.threadBefore.all(chat.id, around).reverse(), ...S.threadFrom.all(chat.id, around)]
    : S.thread.all(chat.id);
  res.json({ chat, messages, window: windowState(chat.id), atTail: !Number.isFinite(around) || !around });
});

/** Search one conversation's whole history, not just the loaded window. */
app.get('/api/chats/:id/search', (req, res) => {
  const chat = S.chat.get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.status(422).json({ error: 'Type at least two characters.' });
  res.json({ hits: S.searchThread.all(chat.id, q, q) });
});

/** The same search across every conversation — what the sidebar box does once
 *  there is more than a name to go on. */
app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.status(422).json({ error: 'Type at least two characters.' });
  res.json({ hits: S.searchAll.all(q, q) });
});

/** Blue ticks happen HERE — when a human opened the chat — never on ingest. */
app.post('/api/chats/:id/read', wrap(async (req, res) => {
  const chat = S.chat.get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  // The owner account exists to troubleshoot, not to work the queue. Looking at
  // a conversation with it must leave no trace: the team's unread count stands,
  // and — the part that reaches outside — no blue tick appears on the
  // customer's phone for a message no agent has actually read.
  if (S.userById.get(req.user.id)?.is_owner) return res.json({ ok: true, observed: true });
  const keys = S.unreadKeys.all(chat.id, chat.last_read_ts);
  S.markRead.run(now(), chat.id);
  if (keys.length) {
    bridge('/read', { chatId: chat.id, keys: keys.map((k) => ({ id: k.id, participant: chat.is_group ? k.sender_id : undefined })) })
      .catch(() => {}); // best effort: read state is local truth
  }
  broadcast({ type: 'chats' });
  res.json({ ok: true });
}));

/** Claim / release. One owner per chat is what stops two agents double-replying. */
app.post('/api/chats/:id/claim', (req, res) => {
  const chat = S.chat.get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  const release = req.body?.release === true;
  if (!release && chat.assigned_to && chat.assigned_to !== req.user.id && req.body?.takeover !== true) {
    return res.status(409).json({ error: `${chat.assignee_name} is handling this chat.` });
  }
  S.assign.run(release ? null : req.user.id, now(), chat.id);
  broadcast({ type: 'chats' });
  broadcast({ type: 'chat', chat: S.chat.get(chat.id) });
  res.json({ chat: S.chat.get(chat.id) });
});

app.post('/api/chats/:id/send', (req, res) => {
  const chat = S.chat.get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (chat.assigned_to && chat.assigned_to !== req.user.id) {
    return res.status(409).json({ error: `${chat.assignee_name} is handling this chat. Take it over first.` });
  }
  try {
    const msg = queueReply(chat.id, req.body?.body, req.user.id, req.body?.replyTo || null);
    if (!chat.assigned_to) S.assign.run(req.user.id, now(), chat.id); // sending claims it
    broadcast({ type: 'message', message: msg });
    broadcast({ type: 'chats' });
    res.json({ message: msg });
  } catch (err) {
    if (err instanceof GateError) return res.status(422).json({ error: err.message });
    throw err;
  }
});



/** Remove someone from the team. The row survives so their past replies keep
 *  their name in the thread and in reports; the seat is freed and every live
 *  session of theirs dies immediately. */
app.post('/api/admin/users/:id/active', requireAdmin, (req, res) => {
  const user = S.userById.get(Number(req.params.id));
  const active = req.body?.active === true;
  if (!user || user.is_owner) return res.status(404).json({ error: 'No such user.' });
  if (user.id === req.user.id) return res.status(422).json({ error: 'You cannot remove your own account.' });
  if (!active && user.is_admin && S.userList.all().filter((u) => u.is_admin && u.active).length < 2) {
    return res.status(422).json({ error: 'That is the only admin — promote someone else first.' });
  }
  if (active && S.activeCount.get().c >= MAX_TEAM) {
    return res.status(409).json({ error: `The team is full (${MAX_TEAM} seats).` });
  }
  S.setActive.run(active ? 1 : 0, user.id);
  if (!active) S.dropUserSessions.run(user.id);
  res.json({ ok: true });
});

/** Force sign-out. The next request each of them makes lands on the login page. */
app.post('/api/admin/logout-users', requireAdmin, (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(422).json({ error: 'Select at least one user.' });
  const names = [];
  for (const id of ids) {
    const u = S.userById.get(id);
    if (!u || u.is_owner) continue;   // never sign the owner out from the UI
    S.dropUserSessions.run(id);
    names.push(u.name);
  }
  res.json({ ok: true, signedOut: names });
});

/** Set ONE shared password across the agents, in a single action.
 *  Admins are deliberately excluded: they keep their own credentials, so the
 *  admin running this stays signed in and an admin account never becomes one
 *  the whole floor can sign in as. Every agent session dies. */
app.post('/api/admin/reset-all-passwords', requireAdmin, wrap(async (req, res) => {
  const password = String(req.body?.password || '');
  if (password.length < MIN_PW) return res.status(422).json({ error: `Password must be at least ${MIN_PW} characters.` });
  const hash = await hashPassword(password); // one hash, reused: it is one password
  const users = S.agentAccounts.all();
  db.exec('BEGIN');
  try {
    for (const u of users) { S.setPassword.run(hash, u.id); S.dropUserSessions.run(u.id); }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true, count: users.length, names: users.map((u) => u.name) });
}));

// --- reporting ------------------------------------------------------------
const DAY = 86400;
app.get('/api/admin/report', requireAdmin, (req, res) => {
  const from = Number(req.query.from), to = Number(req.query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return res.status(422).json({ error: 'Invalid period.' });
  }
  // Two months of daily rows is already a long table; beyond that the answer is
  // an export, not a screen.
  if (to - from > 62 * DAY) return res.status(422).json({ error: 'Pick a period of two months or less.' });
  res.json({
    days: S.dailyStats.all(from, to),
    agents: S.agentStats.all(from, to),
  });
});

// --- WhatsApp device linking ---------------------------------------------
app.get('/api/admin/whatsapp', requireAdmin, wrap(async (req, res) => {
  try {
    res.json({ ...(await bridge('/link/status')), controls: true });
  } catch {
    // An older service build has no linking endpoints. Report the connection
    // state we already know from the health poll rather than claiming the
    // connection is down while the header says it is up.
    res.json({ state: bridgeStatus, qr: null, number: null, controls: false });
  }
}));

/** Record something that happened to the connection, for the history panel. */
const logWa = (kind, detail, userId = null) => {
  try { S.addWaEvent.run(now(), kind, detail ?? null, userId); } catch { /* history is not worth failing a request over */ }
};

app.post('/api/admin/whatsapp/unlink', requireAdmin, wrap(async (req, res) => {
  const before = await bridge('/link/status').catch(() => ({}));
  const out = await bridge('/link/unlink', {});
  logWa('unlinked', before.number || null, req.user.id);
  broadcast({ type: 'status', status: 'logged_out' });
  res.json(out);
}));

app.post('/api/admin/whatsapp/link', requireAdmin, wrap(async (req, res) => {
  const out = await bridge('/link/start', {});
  logWa('link_requested', null, req.user.id);
  res.json(out);
}));

app.get('/api/admin/whatsapp/history', requireAdmin, (req, res) =>
  res.json({ events: S.waEvents.all() }));

// --- storage --------------------------------------------------------------
// Nothing prunes attachments, so the volume fills quietly. Walking the media
// directory is cheap now and gets less so, hence the short cache: this is a
// panel someone opens, not something on a hot path.
// Only the attachment totals are worth caching: listing a bucket is ~31
// requests, and the local walk stats every file in the directory. The disk
// figures are two syscalls, so they are read fresh on every open — an admin who
// has just deleted something has to watch it go, not wonder for ten minutes
// whether the command worked.
let mediaCache = { at: 0, data: null };
async function storageUsage() {
  const fsStat = statfsSync(path.resolve('data'));
  const total = fsStat.blocks * fsStat.bsize;
  const free = fsStat.bavail * fsStat.bsize;

  const sizeOf = (p) => { try { return statSync(p).size; } catch { return 0; } };
  const dbBytes = ['inbox.db', 'inbox.db-wal', 'inbox.db-shm']
    .reduce((n, f) => n + sizeOf(path.resolve('data', f)), 0);

  if (Date.now() - mediaCache.at >= (isOci() ? 600_000 : 60_000)) {
    let bytes = 0;
    let files = 0;
    let error = null;
    if (isOci()) {
      // This panel is the number a client gets billed against, so it totals what
      // the bucket actually holds rather than a counter we keep and hope stays
      // true. A failure has to say so — reporting 0 would read as "nothing
      // stored", which is the one wrong answer that looks plausible.
      try { ({ bytes, files } = await ociUsage()); }
      catch (err) { error = err.message; }
    } else {
      try {
        for (const f of readdirSync(MEDIA_DIR)) {
          try { bytes += statSync(path.join(MEDIA_DIR, f)).size; files += 1; } catch {}
        }
      } catch { /* no media yet */ }
    }
    // Don't cache a failure — otherwise fixing the PAR means waiting it out to
    // see that it worked.
    mediaCache = { at: error ? 0 : Date.now(), data: { bytes, files, error } };
  }
  const m = mediaCache.data;

  return { total, free, used: total - free,
    mediaBytes: m.bytes, mediaFiles: m.files, dbBytes,
    store: isOci() ? 'oci' : 'disk', quotaBytes: quotaBytes(), mediaError: m.error };
}

app.get('/api/admin/storage', requireAdmin, wrap(async (req, res) => res.json(await storageUsage())));

// --- backups ---------------------------------------------------------------
// A backup sitting on the volume it protects is not a backup: lose the instance
// and it goes with the history it was copying. These live in the bucket, and the
// app only ever lists them, hands one back, or stages one for the next boot.
//
// An admin can see that backups are happening — that is the point of showing
// them. Carrying every conversation off the server, or replacing the live
// history with an older copy, stays with the owner.
app.get('/api/admin/backups', requireAdmin, wrap(async (req, res) => {
  if (!isOci()) return res.json({ store: 'disk', backups: [] });
  // One row per night, not per file. The database and the session archive are
  // two halves of one backup to the person reading this, and what they are
  // called on disk is our business, not theirs. Anything not matching the
  // pattern — a stray test object, say — never reaches the screen.
  const byDate = new Map();
  for (const o of await listObjects(BACKUP_PREFIX)) {
    const m = o.name.slice(BACKUP_PREFIX.length).match(/^(inbox|auth_state)-(\d{4}-\d{2}-\d{2})\./);
    if (!m) continue;
    const [, kind, date] = m;
    const row = byDate.get(date) || { date, bytes: 0, at: null, chats: false, session: false };
    row.bytes += o.size || 0;
    if (o.timeCreated && (!row.at || o.timeCreated > row.at)) row.at = o.timeCreated;
    row[kind === 'inbox' ? 'chats' : 'session'] = true;
    byDate.set(date, row);
  }
  const backups = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
  res.json({ store: 'oci', backups, canRestore: !!req.user.is_owner });
}));

// Addressed by date, never by filename. The browser never learns what these
// objects are called, and there is no user-supplied path left to sanitise.
const backupDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);

app.get('/api/admin/backups/:date/download', requireOwner, wrap(async (req, res) => {
  const date = backupDate(req.params.date);
  if (!date) return res.status(422).json({ error: 'Not a backup date.' });
  const name = `inbox-${date}.db`;
  const buf = await getObject(BACKUP_PREFIX + name);
  if (!buf) return res.status(404).json({ error: 'That backup is no longer in the bucket.' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"`);
  res.send(buf);
}));

/** Stage a backup and stop. The swap happens in db.js on the way back up,
 *  because writing over the database file while a connection is open to it
 *  corrupts it — there is no safe way to do this in place. */
app.post('/api/admin/backups/:date/restore', requireOwner, wrap(async (req, res) => {
  const date = backupDate(req.params.date);
  if (!date) return res.status(422).json({ error: 'Not a backup date.' });
  // The typed date has to come back with the request. The UI asks for it, but
  // the check belongs here as well: this route replaces every conversation in
  // the app, and a bare POST to the URL should not be enough to set that off.
  if (String(req.body?.confirm || '').trim() !== date) {
    return res.status(422).json({ error: 'Confirm by sending the backup date.' });
  }
  const name = `inbox-${date}.db`;

  const buf = await getObject(BACKUP_PREFIX + name);
  if (!buf) return res.status(404).json({ error: 'That backup is no longer in the bucket.' });

  writeFileSync(`${DB_FILE}.restore`, buf);
  logWa('backup_restored', date, req.user.id);
  res.json({ ok: true, name });

  // Answer first, then go down so the restart picks the staged copy up. A crash
  // mid-send is already handled — requeueStuck runs on boot — so nothing
  // outbound is lost by stopping here.
  console.log(`♻️  restore staged from ${name} by ${req.user.username} — restarting`);
  setTimeout(() => process.exit(0), 250);
}));

// Importing the address book is a deliberate choice, made once per linked
// phone. Neither route touches pairing.
app.post('/api/admin/whatsapp/contacts/sync', requireAdmin, wrap(async (req, res) => {
  const out = await bridge('/contacts/sync', {});
  logWa('contacts_synced', null, req.user.id);
  res.json(out);
}));

app.post('/api/admin/whatsapp/contacts/skip', requireAdmin, wrap(async (req, res) => {
  const out = await bridge('/contacts/skip', {});
  logWa('contacts_skipped', null, req.user.id);
  res.json(out);
}));

/** Attachment upload. Same gate as any other outbound message: an image sent to
 *  20 chats is as much a broadcast as a sentence is. */
app.post('/api/chats/:id/media', wrap(async (req, res) => {
  const chat = S.chat.get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (chat.assigned_to && chat.assigned_to !== req.user.id) {
    return res.status(409).json({ error: `${chat.assignee_name} is handling this chat. Take it over first.` });
  }

  const rawName = String(req.body?.filename || 'file');
  const data = String(req.body?.data || '');
  // Strip any directory part and anything exotic: this name reaches the disk.
  const safeName = path.basename(rawName).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
  const ext = safeName.toLowerCase().split('.').pop();
  if (!data) return res.status(422).json({ error: 'No file received.' });

  const buf = Buffer.from(data, 'base64');
  if (!buf.length) return res.status(422).json({ error: 'That file appears to be empty.' });
  if (buf.length > MAX_UPLOAD_MB * 1024 * 1024) {
    return res.status(413).json({ error: `File is too large (max ${MAX_UPLOAD_MB} MB).` });
  }

  // Ask the gate BEFORE the bytes go anywhere. A PAR cannot delete objects, so
  // storing first and cleaning up after would strand an orphan in the bucket
  // every time a file is refused. Passing null for the path does not weaken the
  // duplicate-attachment rule: this upload's name is freshly random and could
  // never match an earlier send, and queueMedia re-runs the full check with the
  // real path a moment later.
  let stored = null;
  try {
    checkOutbound(chat.id, req.body?.caption, now(), true, null);
    stored = await saveMedia(path.join(MEDIA_DIR, `${randomBytes(4).toString('hex')}-${safeName}`), buf);
    const msg = queueMedia(chat.id, req.body?.caption, req.user.id, {
      mediaType: kindOf(ext), mediaPath: stored, replyTo: req.body?.replyTo || null,
    });
    if (!chat.assigned_to) S.assign.run(req.user.id, now(), chat.id); // sending claims it
    broadcast({ type: 'message', message: msg });
    broadcast({ type: 'chats' });
    res.json({ message: msg });
  } catch (err) {
    if (stored) await removeMedia(stored); // only the rare race: gate refused after the bytes landed
    if (err instanceof GateError) return res.status(422).json({ error: err.message });
    throw err;
  }
}));


/** Forward an existing message (text or attachment) into another chat.
 *  Goes through the same gate as anything else outbound: forwarding is the
 *  easiest way to turn one message into a broadcast, so it gets no shortcut. */
app.post('/api/messages/:id/forward', (req, res) => {
  const src = S.message.get(req.params.id);
  const to = S.chat.get(String(req.body?.to || ''));
  if (!src) return res.status(404).json({ error: 'That message no longer exists.' });
  if (!to) return res.status(404).json({ error: 'Pick a conversation to forward to.' });
  if (to.id === src.chat_id) return res.status(422).json({ error: 'That message is already in this chat.' });
  if (to.assigned_to && to.assigned_to !== req.user.id) {
    return res.status(409).json({ error: `${to.assignee_name} is handling that chat. Take it over first.` });
  }
  try {
    const body = realBody(src.body);
    const msg = src.media_path
      ? queueMedia(to.id, body, req.user.id, { mediaType: src.media_type, mediaPath: src.media_path })
      : queueReply(to.id, body, req.user.id);
    if (!to.assigned_to) S.assign.run(req.user.id, now(), to.id);
    broadcast({ type: 'message', message: msg });
    broadcast({ type: 'chats' });
    res.json({ message: msg, chat: { id: to.id, name: to.display_name || to.name } });
  } catch (err) {
    if (err instanceof GateError) return res.status(422).json({ error: err.message });
    throw err;
  }
});

/** Remember which way up an attachment should be read. Shared, not per agent:
 *  a card straightened once is straight for the whole team from then on. */
app.post('/api/messages/:id/rotation', (req, res) => {
  const deg = Number(req.body?.deg);
  if (![0, 90, 180, 270].includes(deg)) return res.status(422).json({ error: 'Rotation must be 0, 90, 180 or 270.' });
  const r = S.setMediaRotation.run(deg, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'No attachment on that message.' });
  broadcast({ type: 'message', message: S.message.get(req.params.id) });
  res.json({ ok: true, deg });
});

app.post('/api/messages/:id/retry', (req, res) => {
  const msg = S.message.get(req.params.id);
  if (!msg || msg.status !== 'failed') return res.status(404).json({ error: 'No failed message with that id' });
  try {
    assertSendable(msg);
    S.setStatus.run('queued', null, msg.id);
    broadcast({ type: 'message', message: S.message.get(msg.id) });
    res.json({ message: S.message.get(msg.id) });
  } catch (err) {
    if (err instanceof GateError) return res.status(422).json({ error: err.message });
    throw err;
  }
});
// A retry re-runs the gate, not just the window: the broadcast guards have to
// apply again. The hourly caps are no longer part of this check because they
// are no longer a refusal — a retried message goes back on the queue and the
// sender holds it until the hour has room, exactly as it does a new one.
function assertSendable(msg) {
  checkOutbound(msg.chat_id, msg.body, now(), !!msg.media_path, msg.media_path || null);
}

app.get('/api/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ type: 'status', status: bridgeStatus })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

app.get('/media/:file', requireAuth, wrap(async (req, res) => {
  const name = path.basename(req.params.file); // basename: no traversal
  const file = path.join(MEDIA_DIR, name);
  // Disk first: mid-migration a file can be in both places, and the local copy
  // is the cheaper read. In OCI mode it was never written here at all, so this
  // falls through to the bucket.
  const local = existsSync(file);
  const upstream = local ? null : await openMedia(name, {
    range: req.headers.range,
    'if-none-match': req.headers['if-none-match'],
    'if-modified-since': req.headers['if-modified-since'],
  });
  if (!local && !upstream) return res.status(404).end();
  // These files came off the wire (or off an agent's disk). Only ever render the
  // types we recognise inline; everything else downloads, so an uploaded .html
  // can't execute as same-origin script against the inbox.
  const ext = name.toLowerCase().split('.').pop();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // ?download=1 is what a drag onto the desktop and the Download action ask
  // for: an image is normally served inline so it can render in the thread,
  // but when it is being saved it has to arrive as a file.
  //
  // PDFs are the one document type served inline, so an agent can read a
  // licence or certificate without downloading it first. The rule this
  // narrows is still intact — everything else downloads, so an uploaded .html
  // can never execute as same-origin script against the inbox — and the type
  // is stated explicitly rather than sniffed, with nosniff set above.
  const inlinePdf = ext === 'pdf' && !('download' in req.query);
  if (inlinePdf) res.setHeader('Content-Type', 'application/pdf');
  if (!inlinePdf && ('download' in req.query || kindOf(ext) === 'document')) {
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"`);
  }
  // An attachment never changes: its name carries random bytes, the file is
  // never rewritten, and rotation lives in the DB rather than in the pixels. So
  // the browser may keep it for good — reopening a thread should cost no
  // requests at all. Private, because these are answered only to a signed-in
  // agent and must never sit in a shared proxy.
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  // cacheControl:false so send() does not overwrite that with its own default.
  if (local) return res.sendFile(file, { cacheControl: false });

  // Nothing changed since the browser last asked: no body, no bytes off the
  // bucket. Without this every revisit re-downloads the whole attachment.
  if (upstream.status === 304) return res.status(304).end();

  // From the bucket. Range has to survive in both directions or video seeking
  // breaks: the request carried it up, and 206/Content-Range come back down.
  // Type is still stated from the extension rather than trusting the bucket.
  if (!inlinePdf) res.type(kindOf(ext) === 'document' ? 'application/octet-stream' : ext);
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  res.status(upstream.status);
  Readable.fromWeb(upstream.body)
    .on('error', (err) => { console.error('media stream:', err?.message || err); res.destroy(); })
    .pipe(res);
}));

// Last resort: the UI only ever parses JSON, so errors must be JSON too.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: `File is too large (max ${MAX_UPLOAD_MB} MB).` });
  }
  console.error('unhandled:', err?.stack || err);
  res.status(500).json({ error: 'Something broke on the server. Try again.' });
});

await seedAdmin();
S.dropExpiredSessions.run(now() - 12 * 3600);

app.listen(PORT, () => {
  console.log(`📥 Support inbox on http://localhost:${PORT}`);
  console.log(`🌉 Bridge: ${BRIDGE_URL}`);
  if (!S.chatList.all().length) console.log('   (no chats yet — they appear as messages arrive)');
  ingest();
  watchBridge();
  syncContacts();
  runSender(bridge, broadcast);
});
