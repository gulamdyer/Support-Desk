/** Outbound safety gate + paced sender.
 *
 *  This file is the reason the number survives. Bans are driven by recipient
 *  behaviour — blocks and reports — and by burst/broadcast patterns, almost all
 *  of it on the outbound side. So every outgoing message passes four checks and
 *  leaves through a single slow queue. There is deliberately NO bulk-send path.
 */
import path from 'node:path';
import S, { now } from './db.js';

const env = (k, d) => Number(process.env[k] ?? d);
export const LIMITS = {
  windowHours:   () => env('WINDOW_HOURS', 24),
  chatHourly:    () => env('CHAT_HOURLY_CAP', 15),
  globalHourly:  () => env('GLOBAL_HOURLY_CAP', 120),
  duplicateChats:() => env('DUPLICATE_CHAT_LIMIT', 3),
};

/** Why this chat can or cannot be replied to right now.
 *  Pure read — the UI calls it to disable the composer *before* the agent
 *  types, so nobody writes a reply that is then rejected. */
export function windowState(chatId, at = now()) {
  const chat = S.chat.get(chatId);
  if (!chat) return { open: false, reason: 'Unknown chat.' };
  const hrs = LIMITS.windowHours();
  const age = at - chat.last_inbound_ts;
  if (!chat.last_inbound_ts) {
    return { open: false, reason: 'No incoming message from this contact yet. WhatsApp is reply-only here — they must message first.' };
  }
  if (age > hrs * 3600) {
    return { open: false, expired: true,
      reason: `The ${hrs}h reply window closed ${Math.floor(age / 3600)}h ago. Wait for them to message again, or call them.` };
  }
  return { open: true, expiresInSec: hrs * 3600 - age };
}

/** Full pre-send check. Throws GateError with a message meant for the agent. */
export class GateError extends Error {}

export function checkOutbound(chatId, body, at = now(), hasMedia = false, mediaPath = null) {
  const text = (body ?? '').trim();
  if (!text && !hasMedia) throw new GateError('Message is empty.');
  if (text.length > 4000) throw new GateError('Message is too long (max 4000 characters).');

  const w = windowState(chatId, at);
  if (!w.open) throw new GateError(w.reason);

  const hourAgo = at - 3600;
  if (S.chatHourly.get(chatId, hourAgo).c >= LIMITS.chatHourly()) {
    throw new GateError(`Hourly limit for this chat reached (${LIMITS.chatHourly()}). Pause — rapid-fire messaging is what gets numbers banned.`);
  }
  if (S.globalHourly.get(hourAgo).c >= LIMITS.globalHourly()) {
    throw new GateError(`Team-wide hourly send limit reached (${LIMITS.globalHourly()}). Sending is paused to protect the number.`);
  }
  // Identical text fanned out across chats is the signature of a broadcast,
  // which is the single fastest way to lose the number. An empty caption is not
  // a duplicate — several photos sent without captions must not trip this.
  if (text && S.duplicateChats.get(text, at - 86400).c >= LIMITS.duplicateChats()) {
    throw new GateError(`This exact text has already gone to ${LIMITS.duplicateChats()} other chats today. Personalise it — identical bulk messages get the number banned.`);
  }
  // Same rule for attachments: an image forwarded to twenty chats is a
  // broadcast regardless of whether anyone typed a caption.
  if (mediaPath && S.duplicateMedia.get(mediaPath, at - 86400).c >= LIMITS.duplicateChats()) {
    throw new GateError(`This file has already gone to ${LIMITS.duplicateChats()} other chats today. Forwarding the same attachment around is what gets numbers banned.`);
  }
  return text;
}

/** Queue a reply. Never sends inline: the pacer owns the wire. */
export function queueReply(chatId, body, userId, replyTo = null) {
  const text = checkOutbound(chatId, body);
  const id = `local-${crypto.randomUUID()}`;
  S.queue.run(id, chatId, text, now(), userId, replyTo);
  return S.message.get(id);
}

/** Queue an attachment. Same gate as text — an image blasted to 20 chats is
 *  every bit as much a broadcast as a sentence is. */
export function queueMedia(chatId, caption, userId, { mediaType, mediaPath, replyTo = null }) {
  const text = checkOutbound(chatId, caption, now(), true, mediaPath);
  const id = `local-${crypto.randomUUID()}`;
  S.queueMedia.run(id, chatId, text, now(), userId, mediaType, mediaPath, replyTo);
  return S.message.get(id);
}

// --- paced sender -------------------------------------------------------
// One message at a time, human-shaped: typing indicator, a delay that scales
// with length, then a randomised gap. An agent clearing 20 chats sends over
// minutes, not in one burst.
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSender(bridge, broadcast) {
  S.requeueStuck.run(); // a crash mid-send must not strand a message
  for (;;) {
    const msg = S.nextQueued.get();
    if (!msg) { await sleep(700); continue; }

    S.setStatus.run('sending', null, msg.id);
    broadcast({ type: 'message', message: S.message.get(msg.id) });
    try {
      // The customer sees the message exactly as it was typed. Who sent it is
      // recorded in `sent_by` and shown inside the inbox, not bolted onto the
      // text the customer reads.
      const text = msg.body;

      // A quote needs the ORIGINAL WhatsApp id, not our local one.
      const src = msg.reply_to ? S.quoteSource.get(msg.reply_to, msg.reply_to) : null;
      const quoted = src && (src.wa_id || src.id) ? {
        id: src.wa_id || src.id,
        fromMe: !!src.from_me,
        participant: src.sender_id || null,
        text: src.body || '',
      } : undefined;

      await bridge('/typing', { chatId: msg.chat_id }).catch(() => {});
      await sleep(Math.min(Math.max((msg.body || '').length * 40, 800), 4000));

      const res = msg.media_path
        ? await bridge('/send-media', {
          chatId: msg.chat_id,
          filePath: path.resolve(msg.media_path),
          mediaType: msg.media_type || undefined,
          caption: msg.body || undefined,
          fileName: path.basename(msg.media_path).replace(/^[0-9a-f]{8}-/, ''),
          quoted,
        })
        : await bridge('/send', { chatId: msg.chat_id, message: text, quoted });
      S.setSent.run(res.messageId ?? null, msg.id);
      S.upsertChat.run(msg.chat_id, null, msg.chat_id, 0, now());
      await sleep(rand(env('SEND_GAP_MIN_MS', 3000), env('SEND_GAP_MAX_MS', 8000)));
    } catch (err) {
      S.setStatus.run('failed', String(err.message || err).slice(0, 300), msg.id);
      await sleep(2000);
    }
    broadcast({ type: 'message', message: S.message.get(msg.id) });
  }
}
