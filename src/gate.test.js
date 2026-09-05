/** The only test that matters: the outbound gate. If this breaks, the number
 *  eventually gets banned.  Run: npm test */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

process.chdir(mkdtempSync(`${tmpdir()}/inbox-test-`)); // db.js resolves ./data from cwd
const { default: S, recordInbound, now } = await import('./db.js');
const { checkOutbound, windowState, GateError } = await import('./gate.js');

const T = now();
S.addUser.run('agent', 'Agent One', 'x:y', T, 0);   // sent_by has a FK
const inbound = (chat, ts, body = 'hi') => recordInbound({
  messageId: `in-${chat}-${ts}-${Math.random()}`, chatId: chat, senderId: chat,
  senderName: 'Cust', body, timestamp: ts, isGroup: false, fromMe: false,
});
const outbound = (chat, body, ts = T) =>
  S.queue.run(`out-${Math.random()}`, chat, body, ts, 1);
const rejects = (fn, needle) => {
  try { fn(); assert.fail(`expected rejection containing ${needle!==undefined?needle:''}`); }
  catch (e) {
    assert.ok(e instanceof GateError, `wrong error type: ${e.message}`);
    if (needle) assert.ok(e.message.includes(needle), `"${e.message}" lacks "${needle}"`);
  }
};

// 1. Never initiate — a chat with no inbound message is unreplyable.
S.upsertChat.run('cold@s.whatsapp.net', 'Cold', 'cold@s.whatsapp.net', 0, T);
assert.equal(windowState('cold@s.whatsapp.net').open, false);
rejects(() => checkOutbound('cold@s.whatsapp.net', 'hello there'), 'must message first');

// 2. The 24h service window closes.
inbound('old@s.whatsapp.net', T - 25 * 3600);
assert.equal(windowState('old@s.whatsapp.net').open, false);
rejects(() => checkOutbound('old@s.whatsapp.net', 'still there?'), 'window closed');

// 3. A live conversation is replyable.
inbound('live@s.whatsapp.net', T - 600);
assert.equal(windowState('live@s.whatsapp.net').open, true);
assert.equal(checkOutbound('live@s.whatsapp.net', '  yes we do  '), 'yes we do');
rejects(() => checkOutbound('live@s.whatsapp.net', '   '), 'empty');

// 4. Per-chat hourly cap stops rapid-fire.
for (let i = 0; i < 15; i++) outbound('live@s.whatsapp.net', `reply ${i}`);
rejects(() => checkOutbound('live@s.whatsapp.net', 'one more'), 'Hourly limit');

// 5. Broadcast guard: identical text across chats is blocked.
for (const n of [1, 2, 3]) {
  const c = `blast${n}@s.whatsapp.net`;
  inbound(c, T - 300);
  outbound(c, 'Big sale this weekend!');
}
inbound('blast4@s.whatsapp.net', T - 300);
rejects(() => checkOutbound('blast4@s.whatsapp.net', 'Big sale this weekend!'), 'Personalise');
// ...but a personalised message to the same chat still goes through.
assert.equal(checkOutbound('blast4@s.whatsapp.net', 'Hi Sara, your order ships today.'),
  'Hi Sara, your order ships today.');

// 6. Inbound is deduped — a mirrored echo must not double up.
const dup = { messageId: 'dup-1', chatId: 'live@s.whatsapp.net', senderId: 'x',
  body: 'once', timestamp: T, isGroup: false, fromMe: false };
assert.equal(recordInbound(dup), true);
assert.equal(recordInbound(dup), false);

console.log('✅ gate: 6/6 — reply-only window, rate caps, broadcast guard, dedupe');
