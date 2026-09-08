/** SQLite store — the source of truth. WhatsApp is only the transport.
 *  Uses node:sqlite (built in since Node 22.5) so there is no DB dependency. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// DB_PATH exists so tests can run against a throwaway file. Unset in production.
const DB_PATH = process.env.DB_PATH || path.resolve('data', 'inbox.db');
mkdirSync(path.dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  pw_hash    TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  is_admin   INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  -- The break-glass account seeded from ADMIN_USERNAME. It belongs to whoever
  -- runs the server, not to the customer using it, so it is kept out of the
  -- team list, the seat count and every bulk action. Hiding it in the UI would
  -- not be enough — the rules below are enforced in SQL and in the routes.
  is_owner   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id              TEXT PRIMARY KEY,          -- WhatsApp JID
  name            TEXT,
  is_group        INTEGER NOT NULL DEFAULT 0,
  last_ts         INTEGER NOT NULL DEFAULT 0,
  last_inbound_ts INTEGER NOT NULL DEFAULT 0, -- basis for the 24h service window
  last_read_ts    INTEGER NOT NULL DEFAULT 0, -- shared inbox => shared read state
  assigned_to     INTEGER REFERENCES users(id),
  assigned_ts     INTEGER NOT NULL DEFAULT 0
);

-- One timeline, both directions. Outbound rows appear immediately as 'queued'
-- so the agent always sees what happened to their message.
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,   -- wa id (inbound) or local uuid (outbound)
  wa_id       TEXT,               -- WhatsApp id once known; dedupes the echo
  chat_id     TEXT NOT NULL,
  sender_id   TEXT,
  sender_name TEXT,
  body        TEXT NOT NULL DEFAULT '',
  from_me     INTEGER NOT NULL DEFAULT 0,
  ts          INTEGER NOT NULL,
  media_type  TEXT,
  media_path  TEXT,
  sent_by     INTEGER REFERENCES users(id),  -- which agent, for outbound
  status      TEXT NOT NULL DEFAULT 'received',
                -- received | queued | sending | sent | failed
  error       TEXT,
  reply_to    TEXT            -- id (or wa_id) of the message this one quotes
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_wa ON messages(wa_id) WHERE wa_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(chat_id, ts);
CREATE INDEX IF NOT EXISTS idx_msg_queue ON messages(status, ts) WHERE status IN ('queued','sending');
CREATE INDEX IF NOT EXISTS idx_chat_recent ON chats(last_ts DESC);
CREATE INDEX IF NOT EXISTS idx_sess_user ON sessions(user_id);
`);

// --- contacts -------------------------------------------------------------
// One row per PERSON. WhatsApp identifies the same human by two different ids —
// a phone number and a privacy LID — and a message arrives carrying whichever
// one it feels like, so the ids live in their own table pointing back at the
// person. That keeps lookups to two primary-key hops without storing anybody
// twice.
//
// The original shape keyed `contacts` by the id itself, which meant one row per
// id and therefore two rows per person. Fold those together before creating the
// new tables; `contacts_legacy` is drained and dropped at the bottom of this file.
const legacyContacts =
  db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='contacts'`).get() &&
  db.prepare(`PRAGMA table_info(contacts)`).all().some((c) => c.name === 'key');
if (legacyContacts) db.exec(`ALTER TABLE contacts RENAME TO contacts_legacy`);

db.exec(`
CREATE TABLE IF NOT EXISTS contacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lid        TEXT,               -- WhatsApp's privacy id
  phone      TEXT,               -- real number, when known
  name       TEXT,               -- as saved in the linked phone's address book
  push_name  TEXT,               -- what the contact calls themselves
  updated_ts INTEGER NOT NULL
);

-- Every id this person is reachable under. Two rows here beat two contact rows:
-- the duplication is a pair of short strings, not a copy of the whole person.
CREATE TABLE IF NOT EXISTS contact_keys (
  key        TEXT PRIMARY KEY,   -- digits of a LID or a phone number
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ckeys_contact ON contact_keys(contact_id);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_lid   ON contacts(lid)   WHERE lid IS NOT NULL;

-- Who linked or unlinked the phone, and whether they imported the address
-- book. Handing this inbox to somebody else means handing over the question
-- "when did this number change, and who agreed to the contacts being pulled?"
-- — which nothing recorded until now.
CREATE TABLE IF NOT EXISTS wa_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  kind    TEXT NOT NULL,   -- link_requested | linked | unlinked | contacts_synced | contacts_skipped
  detail  TEXT,            -- the number, or how many contacts arrived
  user_id INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_wa_events_ts ON wa_events(ts DESC);
`);

// Migration for databases created before roles existed. CREATE TABLE IF NOT
// EXISTS above is a no-op on them, so the column has to be added by hand.
for (const [col, ddl] of [
  ['is_admin', 'ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0'],
  ['active', 'ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1'],
  ['is_owner', 'ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0'],
]) {
  if (!db.prepare(`PRAGMA table_info(users)`).all().some((c) => c.name === col)) db.exec(ddl);
}
if (!db.prepare(`PRAGMA table_info(messages)`).all().some((c) => c.name === 'reply_to')) {
  db.exec(`ALTER TABLE messages ADD COLUMN reply_to TEXT`);
}

// JIDs appear as "<digits>@lid", "<digits>@s.whatsapp.net" or with a device
// suffix ("<digits>:12@..."). One key per person, whichever form turns up.
db.function('jidkey', { deterministic: true }, (jid) => String(jid ?? '').replace(/[@:].*$/, ''));

export const now = () => Math.floor(Date.now() / 1000);

/** Resolve a JID to its person. Two primary-key hops: the id finds the alias
 *  row, the alias row finds the contact. `a` is the contact alias used by the
 *  surrounding query; the alias table borrows it with a `k` suffix. */
const joinContact = (a, expr) =>
  `LEFT JOIN contact_keys ${a}k ON ${a}k.key = jidkey(${expr})
     LEFT JOIN contacts ${a} ON ${a}.id = ${a}k.contact_id`;

/** True when a contact from the bridge differs from the row already stored.
 *  The whole address book arrives on every sync pass, so this is what stops
 *  thousands of identical rows being rewritten — same name and same number
 *  means there is nothing to do. */
export const contactChanged = (prev, c) =>
  !prev || prev.name !== (c.name ?? null) || prev.phone !== (c.phone ?? null);

// --- contact writes -------------------------------------------------------
const CQ = {
  byKey:   db.prepare(`SELECT contact_id AS id FROM contact_keys WHERE key = ?`),
  byPhone: db.prepare(`SELECT id FROM contacts WHERE phone = ? LIMIT 1`),
  byLid:   db.prepare(`SELECT id FROM contacts WHERE lid = ? LIMIT 1`),
  insert:  db.prepare(`INSERT INTO contacts (lid, phone, name, push_name, updated_ts)
    VALUES (?,?,?,?,?)`),
  // Null fields never clobber what is already known — a later event that only
  // carries a pushName must not erase the address-book name.
  update:  db.prepare(`UPDATE contacts SET
      lid        = COALESCE(?, lid),
      phone      = COALESCE(?, phone),
      name       = COALESCE(?, name),
      push_name  = COALESCE(?, push_name),
      updated_ts = ?
    WHERE id = ?`),
  addKey:  db.prepare(`INSERT OR IGNORE INTO contact_keys (key, contact_id) VALUES (?,?)`),
  byId:    db.prepare(`SELECT * FROM contacts WHERE id = ?`),
  repoint: db.prepare(`UPDATE contact_keys SET contact_id = ? WHERE contact_id = ?`),
  remove:  db.prepare(`DELETE FROM contacts WHERE id = ?`),
};

/** Fold two rows that turned out to be the same person into one.
 *  Happens when a chat creates a phone-only row before the LID that belongs to
 *  it is ever seen — the two only become connectable later. */
function mergeContacts(keepId, dropId) {
  const drop = CQ.byId.get(dropId);
  if (drop) CQ.update.run(drop.lid, drop.phone, drop.name, drop.push_name, drop.updated_ts, keepId);
  CQ.repoint.run(keepId, dropId);   // the ids follow the person
  CQ.remove.run(dropId);
}

/** Store one contact against the person it belongs to, creating them if new.
 *  The same person arrives twice — once under their LID, once under their phone
 *  — and both calls must land on a single row. */
function upsertContact(key, lid, phone, name, pushName, ts) {
  const byKey = CQ.byKey.get(key)?.id ?? null;
  const byPhone = phone ? (CQ.byPhone.get(phone)?.id ?? null) : null;
  const byLid = lid ? (CQ.byLid.get(lid)?.id ?? null) : null;

  let id = byKey ?? byPhone ?? byLid;
  if (id == null) {
    id = Number(CQ.insert.run(lid, phone, name, pushName, ts).lastInsertRowid);
  } else {
    for (const other of [byPhone, byLid]) if (other != null && other !== id) mergeContacts(id, other);
    CQ.update.run(lid, phone, name, pushName, ts, id);
  }
  for (const k of new Set([key, phone, lid].filter(Boolean))) CQ.addKey.run(k, id);
  return id;
}

const S = {
  insertInbound: db.prepare(`INSERT OR IGNORE INTO messages
    (id, wa_id, chat_id, sender_id, sender_name, body, from_me, ts, media_type, media_path, status, reply_to)
    VALUES (?,?,?,?,?,?,?,?,?,?,'received',?)`),
  // NULLIF: a "name" that is just the id's digits is a placeholder, never a real
  // name, and must not overwrite one we already know. Belt and braces — the
  // bridge no longer sends those, but nothing downstream should depend on that.
  upsertChat: db.prepare(`INSERT INTO chats (id, name, is_group, last_ts)
    VALUES (?, NULLIF(?, jidkey(?)), ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name    = COALESCE(NULLIF(excluded.name, jidkey(chats.id)), chats.name),
      last_ts = MAX(chats.last_ts, excluded.last_ts)`),
  setChatName: db.prepare(`UPDATE chats SET name = ? WHERE id = ? AND (name IS NULL OR name <> ?)`),
  bumpInbound: db.prepare(`UPDATE chats SET last_inbound_ts = MAX(last_inbound_ts, ?) WHERE id = ?`),
  chatList: db.prepare(`
    SELECT c.*, u.name AS assignee_name,
      CASE WHEN c.is_group = 0 THEN ct.name END AS display_name,
      ct.phone AS contact_phone,
      (SELECT COUNT(*) FROM messages m WHERE m.chat_id=c.id AND m.from_me=0 AND m.ts > c.last_read_ts) AS unread,
      (SELECT m.body FROM messages m WHERE m.chat_id=c.id ORDER BY m.ts DESC, m.rowid DESC LIMIT 1) AS preview,
      (SELECT m.from_me FROM messages m WHERE m.chat_id=c.id ORDER BY m.ts DESC, m.rowid DESC LIMIT 1) AS preview_out
    FROM chats c
    LEFT JOIN users u ON u.id = c.assigned_to
    ${joinContact('ct', 'c.id')}
    ORDER BY c.last_ts DESC LIMIT 300`),
  chat: db.prepare(`SELECT c.*, u.name AS assignee_name,
      CASE WHEN c.is_group = 0 THEN ct.name END AS display_name,
      ct.phone AS contact_phone
    FROM chats c
    LEFT JOIN users u ON u.id = c.assigned_to
    ${joinContact('ct', 'c.id')}
    WHERE c.id = ?`),
  // The newest 500, shown oldest-first. Ordering ASC before the LIMIT would take
  // the oldest 500 instead — invisible until a chat passes 500 messages, then
  // the thread opens on ancient history and never reaches today.
  thread: db.prepare(`SELECT * FROM (
      SELECT m.*, m.rowid AS rid, u.name AS agent_name,
        ct.name AS sender_display, ct.phone AS sender_phone,
      (SELECT q.body FROM messages q
         WHERE m.reply_to IS NOT NULL AND (q.id = m.reply_to OR q.wa_id = m.reply_to)
         LIMIT 1) AS reply_body,
      (SELECT COALESCE(qc.name, qu.name, CASE WHEN q.from_me THEN 'You' END)
         FROM messages q
         LEFT JOIN users qu ON qu.id = q.sent_by
         ${joinContact('qc', 'q.sender_id')}
         WHERE m.reply_to IS NOT NULL AND (q.id = m.reply_to OR q.wa_id = m.reply_to)
         LIMIT 1) AS reply_author,
      (SELECT q.media_type FROM messages q
         WHERE m.reply_to IS NOT NULL AND (q.id = m.reply_to OR q.wa_id = m.reply_to)
         LIMIT 1) AS reply_media
      FROM messages m
      LEFT JOIN users u ON u.id = m.sent_by
      ${joinContact('ct', 'm.sender_id')}
      WHERE m.chat_id = ? ORDER BY m.ts DESC, m.rowid DESC LIMIT 500
    ) ORDER BY ts ASC, rid ASC`),

  // Jumping to a date or a search hit has to reach past the newest 500, so the
  // thread can also be loaded as a window centred on a point in time.
  threadBefore: db.prepare(`SELECT m.*, u.name AS agent_name,
      ct.name AS sender_display, ct.phone AS sender_phone,
      (SELECT q.body FROM messages q
         WHERE m.reply_to IS NOT NULL AND (q.id = m.reply_to OR q.wa_id = m.reply_to)
         LIMIT 1) AS reply_body,
      (SELECT COALESCE(qc.name, qu.name, CASE WHEN q.from_me THEN 'You' END)
         FROM messages q
         LEFT JOIN users qu ON qu.id = q.sent_by
         ${joinContact('qc', 'q.sender_id')}
         WHERE m.reply_to IS NOT NULL AND (q.id = m.reply_to OR q.wa_id = m.reply_to)
         LIMIT 1) AS reply_author,
      (SELECT q.media_type FROM messages q
         WHERE m.reply_to IS NOT NULL AND (q.id = m.reply_to OR q.wa_id = m.reply_to)
         LIMIT 1) AS reply_media
    FROM messages m
    LEFT JOIN users u ON u.id = m.sent_by
    ${joinContact('ct', 'm.sender_id')}
    WHERE m.chat_id = ? AND m.ts < ? ORDER BY m.ts DESC, m.rowid DESC LIMIT 150`),
  threadFrom: db.prepare(`SELECT m.*, u.name AS agent_name,
      ct.name AS sender_display, ct.phone AS sender_phone,
      (SELECT q.body FROM messages q
         WHERE m.reply_to IS NOT NULL AND (q.id = m.reply_to OR q.wa_id = m.reply_to)
         LIMIT 1) AS reply_body,
      (SELECT COALESCE(qc.name, qu.name, CASE WHEN q.from_me THEN 'You' END)
         FROM messages q
         LEFT JOIN users qu ON qu.id = q.sent_by
         ${joinContact('qc', 'q.sender_id')}
         WHERE m.reply_to IS NOT NULL AND (q.id = m.reply_to OR q.wa_id = m.reply_to)
         LIMIT 1) AS reply_author,
      (SELECT q.media_type FROM messages q
         WHERE m.reply_to IS NOT NULL AND (q.id = m.reply_to OR q.wa_id = m.reply_to)
         LIMIT 1) AS reply_media
    FROM messages m
    LEFT JOIN users u ON u.id = m.sent_by
    ${joinContact('ct', 'm.sender_id')}
    WHERE m.chat_id = ? AND m.ts >= ? ORDER BY m.ts ASC, m.rowid ASC LIMIT 350`),

  // Search runs over the whole conversation, not just the loaded window.
  searchThread: db.prepare(`SELECT id, ts, body, from_me, media_type
    FROM messages
    WHERE chat_id = ? AND body <> '' AND body LIKE '%' || ? || '%'
    ORDER BY ts DESC, rowid DESC LIMIT 80`),
  firstMessageTs: db.prepare(`SELECT MIN(ts) AS ts FROM messages WHERE chat_id = ?`),
  message: db.prepare(`SELECT m.*, u.name AS agent_name,
      ct.name AS sender_display, ct.phone AS sender_phone,
      (SELECT q.body FROM messages q
         WHERE m.reply_to IS NOT NULL AND (q.id = m.reply_to OR q.wa_id = m.reply_to)
         LIMIT 1) AS reply_body,
      (SELECT COALESCE(qc.name, qu.name, CASE WHEN q.from_me THEN 'You' END)
         FROM messages q
         LEFT JOIN users qu ON qu.id = q.sent_by
         ${joinContact('qc', 'q.sender_id')}
         WHERE m.reply_to IS NOT NULL AND (q.id = m.reply_to OR q.wa_id = m.reply_to)
         LIMIT 1) AS reply_author,
      (SELECT q.media_type FROM messages q
         WHERE m.reply_to IS NOT NULL AND (q.id = m.reply_to OR q.wa_id = m.reply_to)
         LIMIT 1) AS reply_media
    FROM messages m
    LEFT JOIN users u ON u.id = m.sent_by
    ${joinContact('ct', 'm.sender_id')}
    WHERE m.id = ?`),
  unreadKeys: db.prepare(`SELECT id, sender_id FROM messages
    WHERE chat_id = ? AND from_me = 0 AND ts > ? AND wa_id IS NOT NULL LIMIT 50`),
  markRead: db.prepare(`UPDATE chats SET last_read_ts = MAX(last_read_ts, ?) WHERE id = ?`),
  assign: db.prepare(`UPDATE chats SET assigned_to = ?, assigned_ts = ? WHERE id = ?`),
  releaseStale: db.prepare(`UPDATE chats SET assigned_to = NULL WHERE assigned_to IS NOT NULL AND assigned_ts < ?`),
  queue: db.prepare(`INSERT INTO messages (id, chat_id, body, from_me, ts, sent_by, status, reply_to)
    VALUES (?,?,?,1,?,?, 'queued', ?)`),
  queueMedia: db.prepare(`INSERT INTO messages
    (id, chat_id, body, from_me, ts, sent_by, media_type, media_path, status, reply_to)
    VALUES (?,?,?,1,?,?,?,?, 'queued', ?)`),
  // What the bridge needs to attach a quote on the wire.
  quoteSource: db.prepare(`SELECT id, wa_id, chat_id, sender_id, from_me, body FROM messages
    WHERE id = ? OR wa_id = ? LIMIT 1`),
  nextQueued: db.prepare(`SELECT * FROM messages WHERE status='queued' ORDER BY ts ASC, rowid ASC LIMIT 1`),
  setStatus: db.prepare(`UPDATE messages SET status=?, error=? WHERE id=?`),
  setSent: db.prepare(`UPDATE messages SET status='sent', wa_id=?, error=NULL WHERE id=?`),
  requeueStuck: db.prepare(`UPDATE messages SET status='queued' WHERE status='sending'`),

  // --- outbound gate counters ---
  chatHourly: db.prepare(`SELECT COUNT(*) AS c FROM messages
    WHERE chat_id=? AND from_me=1 AND status IN ('queued','sending','sent') AND ts > ?`),
  globalHourly: db.prepare(`SELECT COUNT(*) AS c FROM messages
    WHERE from_me=1 AND status IN ('queued','sending','sent') AND ts > ?`),
  duplicateChats: db.prepare(`SELECT COUNT(DISTINCT chat_id) AS c FROM messages
    WHERE from_me=1 AND body=? AND status IN ('queued','sending','sent') AND ts > ?`),
  // The same FILE fanned out is every bit the broadcast that the same text is —
  // and forwarding makes it two clicks. A forward reuses the stored path, so
  // identical media is detectable without hashing anything.
  duplicateMedia: db.prepare(`SELECT COUNT(DISTINCT chat_id) AS c FROM messages
    WHERE from_me=1 AND media_path=? AND status IN ('queued','sending','sent') AND ts > ?`),

  // --- reporting ---
  // A "customer responded to" is a distinct chat an agent actually replied in,
  // which is the number a shift is judged on — not raw message volume.
  dailyStats: db.prepare(`SELECT date(ts, 'unixepoch', 'localtime') AS day,
      COUNT(*) AS messages,
      COUNT(DISTINCT chat_id) AS customers,
      COUNT(DISTINCT sent_by) AS agents
    FROM messages
    WHERE from_me = 1 AND sent_by IS NOT NULL AND status = 'sent' AND ts >= ? AND ts < ?
    GROUP BY day ORDER BY day`),
  agentStats: db.prepare(`SELECT u.id, u.name, u.username, u.active,
      COUNT(m.id) AS messages,
      COUNT(DISTINCT m.chat_id) AS customers
    FROM messages m JOIN users u ON u.id = m.sent_by
    WHERE m.from_me = 1 AND m.status = 'sent' AND u.is_owner = 0
      AND m.ts >= ? AND m.ts < ?
    GROUP BY u.id ORDER BY messages DESC`),

  upsertContact,
  // Keyed by id because that is what the bridge sends and what the dedupe in
  // syncContacts compares against.
  contactsAll: db.prepare(`SELECT k.key AS key, c.name, c.phone
    FROM contact_keys k JOIN contacts c ON c.id = k.contact_id`),
  // People, not ids — this is the number the UI shows.
  contactCount: db.prepare(`SELECT COUNT(*) AS c FROM contacts`),

  userByName: db.prepare(`SELECT * FROM users WHERE username = ?`),
  userById: db.prepare(`SELECT id, username, name, is_admin, active, is_owner FROM users WHERE id = ?`),
  addUser: db.prepare(`INSERT INTO users (username, name, pw_hash, created_ts, is_admin) VALUES (?,?,?,?,?)`),
  // Deactivated members keep their rows so old replies still carry their name;
  // they free their seat and can never sign in again.
  userList: db.prepare(`SELECT u.id, u.username, u.name, u.is_admin, u.active, u.created_ts,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS sessions
    FROM users u WHERE u.is_owner = 0
    ORDER BY u.active DESC, u.is_admin DESC, u.username`),
  // Seats and bulk password resets are the customer's team only. The owner
  // account neither consumes a seat nor has its password overwritten — that
  // one lives in the deployment environment.
  activeCount: db.prepare(`SELECT COUNT(*) AS c FROM users WHERE active = 1 AND is_owner = 0`),
  activeUsers: db.prepare(`SELECT id, username, name FROM users WHERE active = 1 AND is_owner = 0`),
  // Who a one-click password reset applies to. Agents share a password so a
  // shift can hand over; admins keep their own, because an admin who can be
  // signed in as by the whole floor is not an admin. The owner is never here.
  agentAccounts: db.prepare(`SELECT id, username, name FROM users
    WHERE active = 1 AND is_owner = 0 AND is_admin = 0`),
  setOwner: db.prepare(`UPDATE users SET is_owner = ? WHERE id = ?`),

  // --- WhatsApp connection history ---
  addWaEvent: db.prepare(`INSERT INTO wa_events (ts, kind, detail, user_id) VALUES (?,?,?,?)`),
  waEvents: db.prepare(`SELECT e.id, e.ts, e.kind, e.detail, u.name AS by_name
    FROM wa_events e LEFT JOIN users u ON u.id = e.user_id
    ORDER BY e.ts DESC, e.id DESC LIMIT 100`),
  lastWaEvent: db.prepare(`SELECT kind, detail FROM wa_events
    WHERE kind IN ('linked','unlinked') ORDER BY ts DESC, id DESC LIMIT 1`),
  setActive: db.prepare(`UPDATE users SET active = ? WHERE id = ?`),
  setPassword: db.prepare(`UPDATE users SET pw_hash = ? WHERE id = ?`),
  setAdmin: db.prepare(`UPDATE users SET is_admin = ? WHERE id = ?`),
  // A password reset must not leave the old sessions usable.
  dropUserSessions: db.prepare(`DELETE FROM sessions WHERE user_id = ?`),
  dropExpiredSessions: db.prepare(`DELETE FROM sessions WHERE created_ts <= ?`),
  addSession: db.prepare(`INSERT INTO sessions (token, user_id, created_ts) VALUES (?,?,?)`),
  session: db.prepare(`SELECT s.user_id, u.username, u.name, u.is_admin, u.active FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.created_ts > ?`),
  dropSession: db.prepare(`DELETE FROM sessions WHERE token = ?`),
};
export default S;

// Drain the pre-split table now that upsertContact exists to fold the twins.
// Phone-bearing rows go first so the person is created under their real number
// and the LID row attaches to them, rather than the other way round.
if (legacyContacts) {
  const rows = db.prepare(`SELECT key, lid, phone, name, push_name, updated_ts
    FROM contacts_legacy ORDER BY phone IS NULL, key`).all();
  db.exec('BEGIN');
  try {
    for (const r of rows) upsertContact(r.key, r.lid, r.phone, r.name, r.push_name, r.updated_ts);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  db.exec('DROP TABLE contacts_legacy');
  const people = S.contactCount.get().c;
  console.log(`📇 contacts: ${rows.length} id rows folded into ${people} people`);
}

/** Record one mirrored message and keep its chat row current.
 *  Returns true if it was new (false = duplicate echo, already stored). */
export function recordInbound(m) {
  const ts = Number(m.timestamp) || now();
  S.upsertChat.run(m.chatId, m.chatName || null, m.chatId, m.isGroup ? 1 : 0, ts);
  const r = S.insertInbound.run(
    m.messageId, m.messageId, m.chatId, m.senderId || null, m.senderName || null,
    m.body || '', m.fromMe ? 1 : 0, ts, m.mediaType || null, m.mediaUrls?.[0] || null,
    m.quotedId || null); // so a customer's reply shows what it answered
  if (r.changes && !m.fromMe) S.bumpInbound.run(ts, m.chatId);
  return r.changes > 0;
}
