#!/usr/bin/env node
/**
 * WhatsApp Bridge — shared-inbox mirror
 *
 * Standalone Node.js process that connects to WhatsApp via Baileys and
 * exposes loopback HTTP endpoints for the inbox server.
 *
 * MIRROR MODE: every message is surfaced, in both directions. Nothing is
 * filtered, nothing is auto-read. The phone stays the PRIMARY device and must
 * remain fully usable, so this bridge is deliberately passive:
 *   - markOnlineOnConnect:false   -> phone keeps its push notifications
 *   - no readMessages() on ingest -> phone keeps its unread badges
 *   - fromMe messages mirrored    -> replies typed on the phone show in the UI
 *
 * Endpoints (matches gateway/platforms/whatsapp.py expectations):
 *   GET  /messages       - Long-poll for new incoming messages
 *   POST /send           - Send a message { chatId, message, replyTo? }
 *   POST /edit           - Edit a sent message { chatId, messageId, message }
 *   POST /send-media     - Send media natively { chatId, filePath, mediaType?, caption?, fileName? }
 *   POST /typing         - Send typing indicator { chatId }
 *   POST /read           - Mark messages read (blue ticks) { chatId, keys }
 *   GET  /chat/:id       - Get chat info
 *   GET  /health         - Health check
 *
 * Usage:
 *   node bridge.js --port 3100 --session ./auth_state
 */

import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import { pairingActive } from './pairing.js';
import express from 'express';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import path from 'path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'fs';
import { randomBytes } from 'crypto';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';

// This process exists to hold one long-lived connection open. A media download
// that dies mid-stream (ECONNRESET) emits 'error' on a stream Baileys owns,
// asynchronously and after the awaited call has settled — no try/catch can see
// it, and the default behaviour is to kill the process. Dropping the WhatsApp
// link (and forcing a resync) over one failed image download is far worse than
// logging it and carrying on, so these are logged loudly and swallowed.
process.on('uncaughtException', (err) => {
  console.error('⚠️  uncaught exception (staying up):', err?.stack || err);
});
process.on('unhandledRejection', (err) => {
  console.error('⚠️  unhandled rejection (staying up):', err?.stack || err);
});

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const WHATSAPP_DEBUG =
  typeof process !== 'undefined' &&
  process.env &&
  typeof process.env.WHATSAPP_DEBUG === 'string' &&
  ['1', 'true', 'yes', 'on'].includes(process.env.WHATSAPP_DEBUG.toLowerCase());

const PORT = parseInt(getArg('port', '3100'), 10);
const SESSION_DIR = getArg('session', path.resolve('auth_state'));
const MEDIA_DIR = getArg('media', path.resolve('data', 'media'));
const BIND = getArg('bind', process.env.BRIDGE_BIND || '127.0.0.1');
const PAIR_ONLY = args.includes('--pair-only');

function normalizeWhatsAppId(value) {
  if (!value) return '';
  return String(value).replace(':', '@');
}

function getMessageContent(msg) {
  const content = msg?.message || {};
  if (content.ephemeralMessage?.message) return content.ephemeralMessage.message;
  if (content.viewOnceMessage?.message) return content.viewOnceMessage.message;
  if (content.viewOnceMessageV2?.message) return content.viewOnceMessageV2.message;
  if (content.documentWithCaptionMessage?.message) return content.documentWithCaptionMessage.message;
  if (content.templateMessage?.hydratedTemplate) return content.templateMessage.hydratedTemplate;
  if (content.buttonsMessage) return content.buttonsMessage;
  if (content.listMessage) return content.listMessage;
  return content;
}

function getContextInfo(messageContent) {
  if (!messageContent || typeof messageContent !== 'object') return {};
  for (const value of Object.values(messageContent)) {
    if (value && typeof value === 'object' && value.contextInfo) {
      return value.contextInfo;
    }
  }
  return {};
}

mkdirSync(SESSION_DIR, { recursive: true });

// Build LID → phone map from the session files. WhatsApp writes both
// lid-mapping-{phone}.json (phone → lid) and lid-mapping-{lid}_reverse.json
// (lid → phone); neither set is complete on its own, so read both.
function buildLidMap() {
  const map = {};
  try {
    for (const f of readdirSync(SESSION_DIR)) {
      const fwd = f.match(/^lid-mapping-(\d+)\.json$/);
      const rev = f.match(/^lid-mapping-(\d+)_reverse\.json$/);
      if (!fwd && !rev) continue;
      const value = JSON.parse(readFileSync(path.join(SESSION_DIR, f), 'utf8'));
      if (!value) continue;
      if (fwd) map[String(value)] = fwd[1];       // file is keyed by phone
      else map[rev[1]] = String(value);           // file is keyed by lid
    }
  } catch {}
  return map;
}
let lidToPhone = buildLidMap();
let phoneToLid = Object.fromEntries(Object.entries(lidToPhone).map(([lid, phone]) => [phone, lid]));


// --- contacts -----------------------------------------------------------
// pushName is what a person calls *themselves*; the address-book name is what
// the linked phone's owner saved them as, and that is the one WhatsApp itself
// displays. Baileys only hands the address book over through contact events,
// so keep our own copy — nothing on disk survives a restart otherwise.
const CONTACTS_FILE = path.join(path.dirname(MEDIA_DIR), 'contacts.json');
const contacts = new Map();
const digitsOf = (jid) => String(jid ?? '').replace(/[@:].*$/, '');

/** Whether the linked phone's address book may be imported.
 *
 *  'pending' — just linked, nobody has been asked yet; the inbox prompts.
 *  'on'      — an admin said yes. Names are stored and served.
 *  'off'     — an admin said no. Numbers still resolve, names never land.
 *
 *  Kept in SESSION_DIR so unlinking wipes it along with the credentials: a new
 *  phone is a new decision, never an inherited yes.
 */
const SYNC_FILE = path.join(SESSION_DIR, 'contact-sync.json');
let contactSync = 'pending';
function loadSyncPref() {
  try {
    const m = JSON.parse(readFileSync(SYNC_FILE, 'utf8')).mode;
    contactSync = m === 'on' || m === 'off' ? m : 'pending';
  } catch { contactSync = 'pending'; }
}
function setSyncPref(mode) {
  contactSync = mode;
  try {
    mkdirSync(SESSION_DIR, { recursive: true });
    writeFileSync(SYNC_FILE, JSON.stringify({ mode }));
  } catch (e) { console.error('contact-sync preference save failed:', e.message); }
}
loadSyncPref();

function loadContacts() {
  try {
    for (const c of JSON.parse(readFileSync(CONTACTS_FILE, 'utf8'))) contacts.set(c.key, c);
    console.log(`📇 ${contactPeople()} contacts loaded from cache`);
  } catch {}
}

let mergeTimer = null;
// creds.update fires constantly during a sync; coalesce the merges.
function scheduleMerge() {
  clearTimeout(mergeTimer);
  mergeTimer = setTimeout(mergeKnownContacts, 5000);
}

let saveTimer = null;
function saveContacts() {
  // Debounced: a history sync fires these by the thousand.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      writeFileSync(CONTACTS_FILE, JSON.stringify([...contacts.values()]));
      console.log(`📇 address book: ${contactPeople()} contacts cached`);
    } catch (e) { console.error('contacts save failed:', e.message); }
  }, 2000);
}

/** Merge one Baileys Contact. Stored under BOTH its lid and its phone digits,
 *  because a message carries whichever form WhatsApp felt like sending. */
function rememberContact(c) {
  if (!c) return;
  const id = String(c.id || '');
  const lid = c.lid ? digitsOf(c.lid) : (id.endsWith('@lid') ? digitsOf(id) : null);
  let phone = c.phoneNumber ? digitsOf(c.phoneNumber)
    : (id.endsWith('@s.whatsapp.net') ? digitsOf(id) : null);
  if (!phone && lid) phone = lidToPhone[lid] || null;
  // Saving a contact on the phone emits it in phone form with no LID. Group
  // messages arrive in LID form, so without this the two never match up.
  const resolvedLid = lid || (phone ? phoneToLid[phone] : null) || null;
  if (!resolvedLid && !phone) return;

  // The saved name is the address book. It is only kept once an admin has
  // asked for the import — the record itself still forms either way, because
  // the LID/phone pair is what lets a real number display instead of a LID.
  const name = contactSync === 'on' ? (c.name || c.verifiedName || null) : null;
  const notify = c.notify || null;
  for (const key of new Set([resolvedLid, phone].filter(Boolean))) {
    const prev = contacts.get(key) || {};
    // Null never overwrites: a later pushName-only event must not wipe the name.
    contacts.set(key, {
      key,
      lid: resolvedLid ?? prev.lid ?? null,
      phone: phone ?? prev.phone ?? null,
      name: name ?? prev.name ?? null,
      notify: notify ?? prev.notify ?? null,
    });
  }
}
const contactFor = (jid) => contacts.get(digitsOf(jid)) || null;
// Each person occupies up to two keys (LID + phone). Count people, not keys.
const contactPeople = () => new Set([...contacts.values()].map((c) => c.phone || c.lid || c.key)).size;

/** Fold LID-only records into the person's phone record once the mapping is
 *  known again. Relinking wipes the LID↔phone map, so the same person briefly
 *  lands under two keys; without this they stay split and inflate the count. */
function mergeKnownContacts() {
  let merged = 0;
  for (const [key, c] of contacts) {
    if (c.phone || !c.lid) continue;
    const phone = lidToPhone[c.lid];
    if (!phone) continue;
    const twin = contacts.get(phone) || {};
    const rec = {
      key: phone,
      lid: c.lid,
      phone,
      name: twin.name ?? c.name ?? null,
      notify: twin.notify ?? c.notify ?? null,
    };
    contacts.set(phone, rec);
    contacts.set(key, { ...rec, key });
    merged += 1;
  }
  if (merged) { console.log(`📇 merged ${merged} split contact records`); saveContacts(); }
  return merged;
}
loadContacts();


/** Pull the whole address book out of app state.
 *
 *  resyncAppState alone is not enough: it resumes from the version already on
 *  disk, and those patches were consumed during the original link (by a process
 *  that wasn't listening for them), so it correctly reports "nothing new" and
 *  returns zero contacts. Clearing the stored version resets the collection to
 *  0 and makes WhatsApp replay every patch. The version file is regenerated.
 */
async function pullAddressBook() {
  try {
    await sock.authState.keys.set({ 'app-state-sync-version': { 'critical_unblock_low': null } });
    await sock.resyncAppState(['critical_unblock_low'], true);
    // The contacts.upsert events land just after this resolves, so the count is
    // logged by the debounced save rather than here.
    console.log('📇 address book resync requested');
    return contacts.size;
  } catch (e) {
    console.error('📇 address book pull failed:', e.message);
    throw e;
  }
}

const logger = pino({ level: 'silent' });

// Message queue for polling
const messageQueue = [];
// ponytail: in-memory hand-off queue. GET /messages drains it, the server writes
// to SQLite synchronously on receipt, so the loss window is one batch across a
// loopback hop. If that ever matters, add an ack cursor instead of splice().
const MAX_QUEUE_SIZE = 2000;

let sock = null;
let connectionState = 'disconnected';
// The admin links the phone from the web UI, so the current QR has to be
// reachable over HTTP, not only printed to a terminal nobody is watching.
let currentQr = null;      // data: URL of the QR that is valid right now
let linkedNumber = null;
let sockRegistered = false;  // true once creds exist: changes how we back off
// Progressive reconnect backoff (fix A, 2026-07-13): fixed 3s retries hammer
// WhatsApp and pattern-match to bot behaviour → raises flag/logout risk.
let reconnectAttempts = 0;
let reconnectTimer = null;   // only ever one pending reconnect
let starting = false;        // single-flight: overlapping sockets fight and get 440'd

function scheduleReconnect(ms) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; startSocket(); }, ms);
}

// --- pairing window -------------------------------------------------------
// See pairing.js: a QR nobody is watching still costs a full pairing session
// with WhatsApp, and doing that all night is what gets linking refused. The
// window opens when an admin asks to link, is held open while the UI polls for
// the QR, and shuts by itself a few minutes after they stop looking.
const PAIR_WINDOW_MS = 3 * 60 * 1000;
let pairingUntil = 0;
const extendPairing = () => { pairingUntil = Date.now() + PAIR_WINDOW_MS; };

/** Tear the pairing socket down and go idle until someone asks again. */
function stopPairing(why) {
  pairingUntil = 0;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  currentQr = null;
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch {}
    try { sock.end(); } catch {}
    sock = null;
  }
  connectionState = 'logged_out';
  console.log(`⏸️  Pairing paused — ${why}. Waiting for an admin to link a phone.`);
}

// Group-subject cache. Per-message we want the real WhatsApp group name (subject)
// e.g. "360° KSA Support" so downstream pricing can read the market country from it.
// groupMetadata() is a network call — NEVER awaited on the ingestion hot path (a slow/
// throttled IQ would stall blue ticks + message queueing for up to Baileys' 60s default
// and could overflow the queue). Instead: read cache-only on the hot path and warm the
// cache in the background. First message per group per hour falls back to the JID prefix
// (downstream then ASKs for country — safe); subsequent messages get the real subject.
const groupSubjectCache = new Map(); // chatId -> { subject, ts }
const GROUP_SUBJECT_TTL_MS = 60 * 60 * 1000; // 1h
const groupSubjectInflight = new Set(); // chatIds currently being fetched
const MAX_GROUP_SUBJECTS = 200;

// Non-blocking read. Returns the cached subject, or null (and warms the cache) if cold/stale.
function getCachedGroupSubject(chatId) {
  const cached = groupSubjectCache.get(chatId);
  if (cached && Date.now() - cached.ts < GROUP_SUBJECT_TTL_MS) return cached.subject;
  warmGroupSubject(chatId); // fire-and-forget — do NOT await on the hot path
  return null;
}

async function warmGroupSubject(chatId) {
  if (groupSubjectInflight.has(chatId)) return;
  if (!sock || connectionState !== 'connected') return; // fail fast during reconnect (matches other sock call sites)
  groupSubjectInflight.add(chatId);
  try {
    const metadata = await sock.groupMetadata(chatId);
    const subject = (metadata && metadata.subject) ? metadata.subject : null;
    setGroupSubject(chatId, subject);
  } catch (err) {
    setGroupSubject(chatId, null); // cache the miss briefly so a flaky group isn't hammered
  } finally {
    groupSubjectInflight.delete(chatId);
  }
}

function setGroupSubject(chatId, subject) {
  // Bound the cache (oldest-out) so it can't grow without limit.
  if (groupSubjectCache.size >= MAX_GROUP_SUBJECTS && !groupSubjectCache.has(chatId)) {
    const oldest = groupSubjectCache.keys().next().value;
    if (oldest !== undefined) groupSubjectCache.delete(oldest);
  }
  groupSubjectCache.set(chatId, { subject, ts: Date.now() });
}

// Subjects can change — refresh the cache when WhatsApp tells us.
function invalidateGroupSubject(chatId) { if (chatId) groupSubjectCache.delete(chatId); }

async function startSocket() {
  // Two sockets on one session fight each other: WhatsApp closes one with 440
  // (replaced) and can log the device out entirely. Never run more than one.
  if (starting) return;
  starting = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch {}
    try { sock.end(); } catch {}
    sock = null;
  }
  try {
    return await openSocket();
  } finally {
    starting = false;
  }
}

async function openSocket() {
  mkdirSync(SESSION_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  // Headless pairing: if a phone number is provided and this session isn't
  // registered yet, pair by CODE instead of QR. Scanning a QR off a Docker log
  // / saved PNG is unreliable (rendering + the code rotates every ~20s), so on
  // servers we request an 8-char code the operator types into WhatsApp
  // (Linked Devices → Link a device → "Link with phone number instead").
  const PAIR_NUMBER = (process.env.WHATSAPP_PAIR_NUMBER || '').replace(/[^0-9]/g, '');
  const usePairingCode = PAIR_NUMBER.length > 0 && !state.creds.registered;
  sockRegistered = !!state.creds.registered;
  let pairingRequested = false;

  // Request ONE 8-char pairing code for this socket's lifetime and surface it
  // (log + session file). We deliberately do NOT re-issue on a timer: a long
  // qrTimeout (above) keeps this socket alive past the code's validity, and
  // issuing a second code would invalidate the one the operator is mid-typing.
  // If the socket does time out unpaired, it reconnects and a fresh code issues
  // once on the new socket.
  const issuePairingCode = () => {
    sock.requestPairingCode(PAIR_NUMBER)
      .then((code) => {
        const pretty = code?.match(/.{1,4}/g)?.join('-') || code;
        console.log(`\n🔗 WhatsApp PAIRING CODE for +${PAIR_NUMBER}: ${pretty}`);
        console.log('   On the phone: WhatsApp → Linked Devices → Link a device →');
        console.log('   "Link with phone number instead" → enter this code.');
        console.log('   This code stays valid for ~3 min and the socket is held open — take your time.\n');
        try { writeFileSync(path.join(SESSION_DIR, 'pairing-code.txt'), `${pretty}\n`); } catch {}
      })
      .catch((e) => {
        console.error('requestPairingCode failed:', e?.message || e);
        pairingRequested = false; // allow a retry on the next qr tick
      });
  };

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Chrome (Linux)', 'Chrome', '120.0.0'],
    // History sync ON: a real linked device does this, and the inbox needs
    // context on day one. markOnlineOnConnect OFF: presence belongs to the
    // phone — holding it permanently is a bot signal AND it silences the
    // phone's push notifications, which the support team still relies on.
    syncFullHistory: true,
    markOnlineOnConnect: false,
    // qrTimeout is how long ONE code is shown before rotating to the next, not
    // a socket keep-alive. The pairing-CODE flow needs a long-lived socket so
    // the operator can finish typing an 8-character code, but applying that to
    // the QR flow froze a single code on screen: WhatsApp expires it after
    // about a minute and closes the session at ~4 (the 428 in the logs), so
    // most of what the admin scanned was already dead. Let the QR rotate.
    qrTimeout: usePairingCode ? 300_000 : 60_000,
    // Required for Baileys 7.x: without this, incoming messages that need
    // E2EE session re-establishment are silently dropped (msg.message === null)
    getMessage: async (key) => {
      // We don't maintain a message store, so return a placeholder.
      // This is enough for Baileys to complete the retry handshake.
      return { conversation: '' };
    },
  });

  sock.ev.on('creds.update', () => {
    saveCreds();
    lidToPhone = buildLidMap();
    phoneToLid = Object.fromEntries(Object.entries(lidToPhone).map(([lid, phone]) => [phone, lid]));
    scheduleMerge();
  });

  // The address book arrives here — on first sync and whenever it changes.
  sock.ev.on('contacts.upsert', (list) => { for (const c of list || []) rememberContact(c); saveContacts(); });
  sock.ev.on('contacts.update', (list) => { for (const c of list || []) rememberContact(c); saveContacts(); });
  sock.ev.on('messaging-history.set', ({ contacts: synced, lidPnMappings }) => {
    for (const c of synced || []) rememberContact(c);
    for (const m of lidPnMappings || []) rememberContact({ id: m.lid, lid: m.lid, phoneNumber: m.pn });
    saveContacts();
    console.log(`📇 contacts known: ${contactPeople()}`);
  });

  // Refresh the cached subject whenever a group is renamed or (re)synced.
  sock.ev.on('groups.update', (updates) => {
    for (const u of updates || []) {
      if (u && u.id && (u.subject !== undefined)) invalidateGroupSubject(u.id);
    }
  });
  sock.ev.on('groups.upsert', (groups) => {
    for (const g of groups || []) {
      if (g && g.id && g.subject) setGroupSubject(g.id, g.subject);
    }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Preferred on servers: pair by code (no camera, no rotating image).
      if (usePairingCode) {
        if (!pairingRequested) {
          pairingRequested = true;
          issuePairingCode();
        }
        return; // don't render the QR when pairing by code
      }
      console.log('\n📱 Scan this QR code with WhatsApp on your phone:\n');
      qrcode.generate(qr, { small: true });
      console.log('\nWaiting for scan...\n');
      // Also render a scannable PNG into the session volume for headless deploys
      // (Coolify/Docker): a phone can't reliably read the terminal-ASCII QR, so
      // operators grab this file instead. Overwritten on every rotation (~20s),
      // so it always holds the current code. Ignored by buildLidMap()'s filter.
      QRCode.toDataURL(qr, { margin: 2, width: 320, errorCorrectionLevel: 'M' })
        .then((url) => { currentQr = url; })
        .catch((e) => console.error('QR data URL failed:', e.message));
      const qrPngPath = path.join(SESSION_DIR, 'qr.png');
      QRCode.toFile(qrPngPath, qr, { margin: 2, width: 512, errorCorrectionLevel: 'M' })
        .then(() => console.log(`🖼️  QR PNG written to ${qrPngPath}`))
        .catch((e) => console.error('QR PNG write failed:', e.message));
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      connectionState = 'disconnected';
      // The code on screen belongs to THIS socket. Once it closes the code is
      // dead, and scanning it gives the phone "couldn't link, try again later".
      // Drop it so the UI shows "preparing" until a live one arrives.
      currentQr = null;

      if (reason === DisconnectReason.loggedOut) {
        // Exiting here used to make relinking a server-shell job. The admin can
        // now do it from the UI, so stay up and wait to be told to relink.
        console.log('❌ Logged out by WhatsApp. Waiting for an admin to link a phone again.');
        connectionState = 'logged_out';
        currentQr = null;
        linkedNumber = null;
      } else if (reason === 515) {
        // 515 = restart requested (common after pairing). Always reconnect fast.
        console.log('↻ WhatsApp requested restart (code 515). Reconnecting...');
        scheduleReconnect(1000);
      } else {
        // Progressive backoff 3s→60s (fix A, 2026-07-13): fixed fast retries
        // hammer WhatsApp and pattern-match to bot behaviour → flag/logout risk.
        // Counter resets on a successful open.
        reconnectAttempts += 1;
        // Nobody is waiting for this QR, so opening another pairing session
        // only spends goodwill with WhatsApp. Go quiet instead.
        if (!pairingActive({ registered: sockRegistered, pairingUntil, pairOnly: PAIR_ONLY })) {
          stopPairing('no admin is watching for a QR');
          return;
        }
        // Backoff protects a REGISTERED session from hammering WhatsApp. While
        // the device is still unlinked, someone is watching the screen waiting
        // to scan: a 60s gap there just means a minute of no usable QR code.
        // 10s while waiting to pair: fast enough that a fresh QR is always on
        // screen, slow enough that we are not hammering WhatsApp from an IP it
        // may already be unhappy about. Backoff still applies once registered.
        const waitingToPair = !sockRegistered;
        const delayMs = waitingToPair
          ? 10000
          : Math.min(3000 * Math.pow(2, reconnectAttempts - 1), 60000);
        console.log(`⚠️  Connection closed (reason: ${reason}). Reconnecting in ${Math.round(delayMs / 1000)}s (attempt ${reconnectAttempts})${waitingToPair ? ' — waiting to pair, retrying fast' : ''}...`);
        scheduleReconnect(delayMs);
      }
    } else if (connection === 'open') {
      connectionState = 'connected';
      reconnectAttempts = 0;
      currentQr = null; // scanned; a stale code must never linger in the UI
      linkedNumber = (sock.user?.id || '').replace(/[:@].*$/, '') || null;
      console.log('✅ WhatsApp connected!');
      // The address book ships in app state, and WhatsApp only pushes that
      // unprompted when a device is FIRST linked. This session was linked on a
      // laptop and copied here, so without an explicit pull the contact list
      // never arrives and every sender shows as a bare number.
      if (!PAIR_ONLY && contactSync === 'on' && contacts.size === 0) pullAddressBook();
      if (PAIR_ONLY) {
        console.log('✅ Pairing complete. Credentials saved.');
        // Give Baileys a moment to flush creds, then exit cleanly
        setTimeout(() => process.exit(0), 2000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // In self-chat mode, your own messages commonly arrive as 'append' rather
    // than 'notify'. Accept both and filter agent echo-backs below.
    if (type !== 'notify' && type !== 'append') return;

    const botIds = Array.from(new Set([
      normalizeWhatsAppId(sock.user?.id),
      normalizeWhatsAppId(sock.user?.lid),
    ].filter(Boolean)));

    for (const msg of messages) {
      if (!msg.message) continue;

      const chatId = msg.key.remoteJid;
      if (WHATSAPP_DEBUG) {
        try {
          console.log(JSON.stringify({
            event: 'upsert', type,
            fromMe: !!msg.key.fromMe, chatId,
            senderId: msg.key.participant || chatId,
            messageKeys: Object.keys(msg.message || {}),
          }));
        } catch {}
      }
      const senderId = msg.key.participant || chatId;
      const isGroup = chatId.endsWith('@g.us');
      // A @lid sender is WhatsApp's privacy identifier, not a phone number.
      // Untranslated it surfaces in the UI as a meaningless 14-digit string,
      // so resolve it through the session's own mapping before anything shows it.
      const rawSenderNumber = senderId.replace(/@.*/, '');
      const senderNumber = senderId.endsWith('@lid')
        ? (lidToPhone[rawSenderNumber] || rawSenderNumber)
        : rawSenderNumber;
      const senderContact = contactFor(senderId) || contacts.get(senderNumber) || null;

      // MIRROR: fromMe messages are kept. A reply typed on the phone must appear
      // in the inbox UI or the support team double-replies. Only WhatsApp's own
      // status/broadcast pseudo-chat is skipped.
      if (chatId === 'status@broadcast' || chatId.endsWith('@broadcast')) continue;

      const messageContent = getMessageContent(msg);
      const contextInfo = getContextInfo(messageContent);
      const mentionedIds = Array.from(new Set((contextInfo?.mentionedJid || []).map(normalizeWhatsAppId).filter(Boolean)));
      const quotedParticipant = normalizeWhatsAppId(contextInfo?.participant || contextInfo?.remoteJid || '');

      // Extract message body
      let body = '';
      let hasMedia = false;
      let mediaType = '';
      const mediaUrls = [];

      if (messageContent.conversation) {
        body = messageContent.conversation;
      } else if (messageContent.extendedTextMessage?.text) {
        body = messageContent.extendedTextMessage.text;
      } else if (messageContent.imageMessage) {
        body = messageContent.imageMessage.caption || '';
        hasMedia = true;
        mediaType = 'image';
        try {
          const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          const mime = messageContent.imageMessage.mimetype || 'image/jpeg';
          const extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
          const ext = extMap[mime] || '.jpg';
          mkdirSync(MEDIA_DIR, { recursive: true });
          const filePath = path.join(MEDIA_DIR, `img_${randomBytes(6).toString('hex')}${ext}`);
          writeFileSync(filePath, buf);
          mediaUrls.push(filePath);
        } catch (err) {
          console.error('[bridge] Failed to download image:', err.message);
        }
      } else if (messageContent.videoMessage) {
        body = messageContent.videoMessage.caption || '';
        hasMedia = true;
        mediaType = 'video';
        try {
          const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          const mime = messageContent.videoMessage.mimetype || 'video/mp4';
          const ext = mime.includes('mp4') ? '.mp4' : '.mkv';
          mkdirSync(MEDIA_DIR, { recursive: true });
          const filePath = path.join(MEDIA_DIR, `vid_${randomBytes(6).toString('hex')}${ext}`);
          writeFileSync(filePath, buf);
          mediaUrls.push(filePath);
        } catch (err) {
          console.error('[bridge] Failed to download video:', err.message);
        }
      } else if (messageContent.audioMessage || messageContent.pttMessage) {
        hasMedia = true;
        mediaType = messageContent.pttMessage ? 'ptt' : 'audio';
        try {
          const audioMsg = messageContent.pttMessage || messageContent.audioMessage;
          const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          const mime = audioMsg.mimetype || 'audio/ogg';
          const ext = mime.includes('ogg') ? '.ogg' : mime.includes('mp4') ? '.m4a' : '.ogg';
          mkdirSync(MEDIA_DIR, { recursive: true });
          const filePath = path.join(MEDIA_DIR, `aud_${randomBytes(6).toString('hex')}${ext}`);
          writeFileSync(filePath, buf);
          mediaUrls.push(filePath);
        } catch (err) {
          console.error('[bridge] Failed to download audio:', err.message);
        }
      } else if (messageContent.documentMessage) {
        body = messageContent.documentMessage.caption || '';
        hasMedia = true;
        mediaType = 'document';
        const fileName = messageContent.documentMessage.fileName || 'document';
        try {
          const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          mkdirSync(MEDIA_DIR, { recursive: true });
          const safeFileName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
          const filePath = path.join(MEDIA_DIR, `doc_${randomBytes(6).toString('hex')}_${safeFileName}`);
          writeFileSync(filePath, buf);
          mediaUrls.push(filePath);
        } catch (err) {
          console.error('[bridge] Failed to download document:', err.message);
        }
      }

      // For media without caption, use a placeholder so the API message is never empty
      if (hasMedia && !body) {
        body = `[${mediaType} received]`;
      }

      // No echo suppression: our own sends are legitimate inbox entries. The
      // server dedupes on messageId (PRIMARY KEY), so a replay is a no-op.

      // Skip empty messages
      if (!body && !hasMedia) {
        if (WHATSAPP_DEBUG) {
          try { 
            console.log(JSON.stringify({ event: 'ignored', reason: 'empty', chatId, messageKeys: Object.keys(msg.message || {}) })); 
          } catch (err) {
            console.error('Failed to log empty message event:', err);
          }
        }
        continue;
      }

      // Resolve the real group subject ("360° KSA Support") so the pricing pipeline can
      // read the market country from it. Cache-only / non-blocking — falls back to the JID
      // prefix (previous behavior) on a cold cache; the background warm fills it for next time.
      let chatName;
      if (isGroup) {
        // The subject cache is warmed in the background, so it is empty for the
        // first message after every restart. Sending the raw JID as a "name"
        // then overwrote the real group name downstream — send nothing instead
        // and let the stored name stand until the real subject arrives.
        chatName = getCachedGroupSubject(chatId);
      } else {
        chatName = (contactFor(chatId) || contacts.get(lidToPhone[digitsOf(chatId)] || ''))?.name
          || msg.pushName || senderNumber;
      }

      const event = {
        messageId: msg.key.id,
        fromMe: !!msg.key.fromMe,   // mirror needs direction
        chatId,
        senderId,
        senderLid: senderId.endsWith('@lid') ? rawSenderNumber : null,
        senderPhone: /^\d{7,15}$/.test(senderNumber) ? senderNumber : null,
        senderName: senderContact?.name || msg.pushName || senderContact?.notify || senderNumber,
        chatName,
        isGroup,
        body,
        hasMedia,
        mediaType,
        mediaUrls,
        mentionedIds,
        quotedParticipant,
        quotedId: contextInfo?.stanzaId || null,
        botIds,
        timestamp: msg.messageTimestamp,
      };

      messageQueue.push(event);
      if (messageQueue.length > MAX_QUEUE_SIZE) {
        messageQueue.shift();
      }

      // NOT auto-read. Blue ticks are a human signal: the server calls
      // POST /read when a support user actually opens the chat. Auto-reading
      // here would clear the phone's unread badges and tell the customer
      // "read" when nobody has read it.

    }
  });
}

// HTTP server
const app = express();
app.use(express.json());

// Poll for new messages (long-poll style)
app.get('/messages', (req, res) => {
  const msgs = messageQueue.splice(0, messageQueue.length);
  res.json(msgs);
});

// Send a message
app.post('/send', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }

  const { chatId, message, quoted } = req.body;
  if (!chatId || !message) {
    return res.status(400).json({ error: 'chatId and message are required' });
  }

  try {
    const sent = await sock.sendMessage(chatId, { text: message }, { quoted: quotedFrom(quoted, chatId) });

    res.json({ success: true, messageId: sent?.key?.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit a previously sent message
app.post('/edit', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }

  const { chatId, messageId, message } = req.body;
  if (!chatId || !messageId || !message) {
    return res.status(400).json({ error: 'chatId, messageId, and message are required' });
  }

  try {
    const key = { id: messageId, fromMe: true, remoteJid: chatId };
    await sock.sendMessage(chatId, { text: message, edit: key });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MIME type map and media type inference for /send-media
const MIME_MAP = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mkv: 'video/x-matroska', '3gp': 'video/3gpp',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function inferMediaType(ext) {
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'avi', 'mkv', '3gp'].includes(ext)) return 'video';
  if (['ogg', 'opus', 'mp3', 'wav', 'm4a'].includes(ext)) return 'audio';
  return 'document';
}

// Send media (image, video, document) natively
app.post('/send-media', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }

  const { chatId, filePath, mediaType, caption, fileName, quoted } = req.body;
  if (!chatId || !filePath) {
    return res.status(400).json({ error: 'chatId and filePath are required' });
  }

  try {
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: `File not found: ${filePath}` });
    }

    const buffer = readFileSync(filePath);
    const ext = filePath.toLowerCase().split('.').pop();
    const type = mediaType || inferMediaType(ext);
    let msgPayload;

    switch (type) {
      case 'image':
        msgPayload = { image: buffer, caption: caption || undefined, mimetype: MIME_MAP[ext] || 'image/jpeg' };
        break;
      case 'video':
        msgPayload = { video: buffer, caption: caption || undefined, mimetype: MIME_MAP[ext] || 'video/mp4' };
        break;
      case 'audio': {
        const audioMime = (ext === 'ogg' || ext === 'opus') ? 'audio/ogg; codecs=opus' : 'audio/mpeg';
        msgPayload = { audio: buffer, mimetype: audioMime, ptt: ext === 'ogg' || ext === 'opus' };
        break;
      }
      case 'document':
      default:
        msgPayload = {
          document: buffer,
          fileName: fileName || path.basename(filePath),
          caption: caption || undefined,
          mimetype: MIME_MAP[ext] || 'application/octet-stream',
        };
        break;
    }

    const sent = await sock.sendMessage(chatId, msgPayload, { quoted: quotedFrom(quoted, chatId) });

    res.json({ success: true, messageId: sent?.key?.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Typing indicator
app.post('/typing', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected' });
  }

  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId required' });

  try {
    await sock.sendPresenceUpdate('composing', chatId);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// Mark messages read (blue ticks). Called by the server ONLY when a support
// user actually opens the chat — never on ingest.
app.post('/read', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }
  const { chatId, keys } = req.body;
  if (!chatId || !Array.isArray(keys) || keys.length === 0) {
    return res.status(400).json({ error: 'chatId and non-empty keys[] are required' });
  }
  try {
    await sock.readMessages(keys.map((k) => ({
      remoteJid: chatId,
      id: k.id,
      participant: k.participant || undefined,
      fromMe: false,
    })));
    res.json({ success: true, count: keys.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chat info
app.get('/chat/:id', async (req, res) => {
  const chatId = req.params.id;
  const isGroup = chatId.endsWith('@g.us');

  if (isGroup && sock) {
    try {
      const metadata = await sock.groupMetadata(chatId);
      return res.json({
        name: metadata.subject,
        isGroup: true,
        participants: metadata.participants.map(p => p.id),
      });
    } catch {
      // Fall through to default
    }
  }

  res.json({
    name: chatId.replace(/@.*/, ''),
    isGroup,
    participants: [],
  });
});

// Health check

/** Rebuild just enough of the original for Baileys to attach a quote.
 *  We keep no message store, so the key + a text body is what we can offer —
 *  which is all WhatsApp needs to render the quoted bubble. */
function quotedFrom(q, chatId) {
  if (!q || !q.id) return undefined;
  return {
    key: {
      remoteJid: chatId,
      id: q.id,
      fromMe: !!q.fromMe,
      ...(q.participant ? { participant: q.participant } : {}),
    },
    message: { conversation: q.text || '' },
  };
}

// --- device linking (admin, proxied by the inbox server) ------------------
/** Drop the stored session so the next socket has to ask for a fresh QR. */
function wipeSession() {
  try {
    for (const f of readdirSync(SESSION_DIR)) {
      if (f === 'qr.png') continue;
      try { rmSync(path.join(SESSION_DIR, f), { force: true }); } catch {}
    }
  } catch {}
  lidToPhone = {};
  phoneToLid = {};
  contactSync = 'pending';   // the next phone gets asked again
  // The address book belongs to the account that was linked, not to the box.
  // Leaving it here bleeds the previous number's contacts into the next one.
  // The cached copy has to go with it: otherwise a restart reloads the old
  // phone's names from disk and the inbox mirrors them straight back.
  clearTimeout(saveTimer);
  contacts.clear();
  try { rmSync(CONTACTS_FILE, { force: true }); } catch {}
}

app.get('/link/status', (req, res) => {
  // The inbox polls this every few seconds while the WhatsApp panel is open,
  // and nothing else calls it — so it is an accurate "somebody is watching"
  // signal. Extend an open window; never open a closed one.
  if (!sockRegistered && pairingUntil) extendPairing();
  return res.json({
    state: connectionState,    // connected | disconnected | logged_out
    qr: currentQr,             // data: URL while a code waits to be scanned
    number: linkedNumber,
    contacts: contactPeople(),
    contactSync,               // pending | on | off
  });
});

/** Drop this device from the phone's linked-devices list and wipe the session.
 *  Destructive and deliberate: nothing reaches WhatsApp until a phone is linked
 *  again, so the inbox keeps working read-only off SQLite in the meantime. */
app.post('/link/unlink', async (req, res) => {
  try {
    try { await sock?.logout(); } catch { /* already gone; wipe anyway */ }
    try { sock?.end?.(); } catch {}
    sock = null;
    connectionState = 'logged_out';
    currentQr = null;
    linkedNumber = null;
    wipeSession();
    console.log('🔓 Device unlinked and session wiped.');
    res.json({ ok: true, state: connectionState });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Open a socket with no credentials, which makes WhatsApp emit a QR. */
app.post('/link/start', async (req, res) => {
  if (connectionState === 'connected') return res.status(409).json({ error: 'A phone is already linked. Unlink it first.' });
  try {
    // A QR is only ever offered when there are NO usable credentials. After a
    // logout the old creds are still on disk and dead: Baileys resumes them,
    // WhatsApp answers 401, and no QR is ever emitted. Clear them first — that
    // is precisely what "link a phone" means.
    wipeSession();
    currentQr = null;
    connectionState = 'connecting';
    reconnectAttempts = 0;
    extendPairing();           // an admin is at the screen; QRs are wanted now
    await startSocket();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The inbox server mirrors this into SQLite so names resolve in the UI.
app.get('/contacts', (req, res) => res.json([...contacts.values()]));

/** Import the address book. This is the only path that turns names on. */
app.post('/contacts/sync', async (req, res) => {
  if (connectionState !== 'connected') return res.status(409).json({ error: 'No phone is linked.' });
  setSyncPref('on');
  try {
    await pullAddressBook();
    res.json({ ok: true, contactSync });
  } catch (e) {
    // The preference stands even if this pull failed — a later reconnect or an
    // explicit resync finishes the job rather than silently staying off.
    res.status(502).json({ error: e.message, contactSync });
  }
});

/** Decline the import. Numbers still resolve; no saved name is ever stored. */
app.post('/contacts/skip', (req, res) => {
  setSyncPref('off');
  res.json({ ok: true, contactSync });
});

// Re-pull the address book on demand (a contact renamed on the phone).
app.post('/contacts/resync', async (req, res) => {
  try {
    res.json({ ok: true, contacts: await pullAddressBook() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: connectionState,
    queueLength: messageQueue.length,
    uptime: process.uptime(),
  });
});

// List all groups this device participates in (read-only; loopback-only server).
// Used to collect group JIDs for config registration without touching the session.
app.get('/groups', async (req, res) => {
  try {
    if (!sock || connectionState !== 'connected') {
      return res.status(503).json({ error: 'not connected' });
    }
    const all = await sock.groupFetchAllParticipating();
    const groups = Object.values(all).map(g => ({ id: g.id, subject: g.subject, participants: (g.participants || []).length }));
    res.json({ count: groups.length, groups });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// Start
if (PAIR_ONLY) {
  // Pair-only mode: just connect, show QR, save creds, exit. No HTTP server.
  console.log('📱 WhatsApp pairing mode');
  console.log(`📁 Session: ${SESSION_DIR}`);
  console.log();
  startSocket();
} else {
  // Loopback by default: on a single host the bridge must not be reachable from
  // the network. In containers the inbox is a SEPARATE network namespace, so
  // 127.0.0.1 makes it unreachable — compose sets BRIDGE_BIND=0.0.0.0, which is
  // still private to the compose network (the service publishes no ports).
  app.listen(PORT, BIND, () => {
    console.log(`🌉 WhatsApp bridge listening on ${BIND}:${PORT} (mirror mode)`);
    console.log(`📁 Session stored in: ${SESSION_DIR}`);
    console.log();
    // A linked session reconnects on its own. An unlinked one waits to be
    // asked: starting a pairing socket on every restart is how a redeploy used
    // to kick off another all-night QR loop.
    if (existsSync(path.join(SESSION_DIR, 'creds.json'))) {
      startSocket();
    } else {
      connectionState = 'logged_out';
      console.log('📴 No phone linked. Waiting for an admin to link one from the UI.');
    }
  });
}
