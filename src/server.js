/** Shared WhatsApp inbox — HTTP server, ingest loop and SSE fan-out. */
import express from 'express';
import path from 'node:path';
import { existsSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import S, { recordInbound, now, db, contactChanged } from './db.js';
import { login, logout, requireAuth, requireAdmin, hashPassword, seedAdmin, publicUser, LoginError } from './auth.js';
import { queueReply, queueMedia, windowState, checkOutbound, runSender, GateError } from './gate.js';

// Same reasoning as the bridge: an async stream error (a media fetch dying
// mid-flight) is emitted where no try/catch can see it, and would otherwise
// take the whole inbox down and disconnect every agent's live stream.
process.on('uncaughtException', (err) => console.error('uncaught (staying up):', err?.stack || err));
process.on('unhandledRejection', (err) => console.error('unhandled rejection (staying up):', err?.stack || err));

const PORT = Number(process.env.PORT || 8080);
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:3100';
const MEDIA_DIR = path.resolve('data', 'media');
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
    if (next !== bridgeStatus) { bridgeStatus = next; broadcast({ type: 'status', status: next }); }
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
  res.json({ hits: S.searchThread.all(chat.id, q) });
});

/** Blue ticks happen HERE — when a human opened the chat — never on ingest. */
app.post('/api/chats/:id/read', wrap(async (req, res) => {
  const chat = S.chat.get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
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

/** Set ONE shared password across the whole team, in a single action.
 *  Every existing session dies, so everybody signs in again with the new one. */
app.post('/api/admin/reset-all-passwords', requireAdmin, wrap(async (req, res) => {
  const password = String(req.body?.password || '');
  if (password.length < MIN_PW) return res.status(422).json({ error: `Password must be at least ${MIN_PW} characters.` });
  const hash = await hashPassword(password); // one hash, reused: it is one password
  const users = S.activeUsers.all();
  db.exec('BEGIN');
  try {
    for (const u of users) { S.setPassword.run(hash, u.id); S.dropUserSessions.run(u.id); }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true, count: users.length });
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

app.post('/api/admin/whatsapp/unlink', requireAdmin, wrap(async (req, res) => {
  const out = await bridge('/link/unlink', {});
  broadcast({ type: 'status', status: 'logged_out' });
  res.json(out);
}));

app.post('/api/admin/whatsapp/link', requireAdmin, wrap(async (req, res) => {
  res.json(await bridge('/link/start', {}));
}));

// Importing the address book is a deliberate choice, made once per linked
// phone. Neither route touches pairing.
app.post('/api/admin/whatsapp/contacts/sync', requireAdmin, wrap(async (req, res) => {
  res.json(await bridge('/contacts/sync', {}));
}));

app.post('/api/admin/whatsapp/contacts/skip', requireAdmin, wrap(async (req, res) => {
  res.json(await bridge('/contacts/skip', {}));
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

  mkdirSync(MEDIA_DIR, { recursive: true });
  const stored = path.join(MEDIA_DIR, `${randomBytes(4).toString('hex')}-${safeName}`);
  writeFileSync(stored, buf);

  try {
    const msg = queueMedia(chat.id, req.body?.caption, req.user.id, {
      mediaType: kindOf(ext), mediaPath: stored, replyTo: req.body?.replyTo || null,
    });
    if (!chat.assigned_to) S.assign.run(req.user.id, now(), chat.id); // sending claims it
    broadcast({ type: 'message', message: msg });
    broadcast({ type: 'chats' });
    res.json({ message: msg });
  } catch (err) {
    unlinkSync(stored); // rejected by the gate — do not leave the file behind
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
// A retry re-runs the FULL gate, not just the window. Checking only the window
// let a failed message be retried past the hourly caps and the broadcast guard,
// which are the limits that actually protect the number.
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

app.get('/media/:file', requireAuth, (req, res) => {
  const name = path.basename(req.params.file); // basename: no traversal
  const file = path.join(MEDIA_DIR, name);
  if (!existsSync(file)) return res.status(404).end();
  // These files came off the wire (or off an agent's disk). Only ever render the
  // types we recognise inline; everything else downloads, so an uploaded .html
  // can't execute as same-origin script against the inbox.
  const ext = name.toLowerCase().split('.').pop();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (kindOf(ext) === 'document') {
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"`);
  }
  res.sendFile(file);
});

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
