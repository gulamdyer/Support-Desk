/** Contacts: one row per person, reachable by either WhatsApp id.
 *
 *  Runs against a throwaway database seeded in the pre-split shape, so this
 *  covers the migration, the dedupe, and — the part that actually matters —
 *  that a name still resolves whether a message arrives carrying a LID or a
 *  phone number.
 */
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'inbox-test-'));
const file = path.join(dir, 'test.db');
process.env.DB_PATH = file;

const LID = '111122223333';
const PHONE = '971500000001';
const NAME = 'Ali Hassan';

// Seed the old shape: one row per id, so the same person twice.
{
  const seed = new DatabaseSync(file);
  seed.exec(`CREATE TABLE contacts (
    key TEXT PRIMARY KEY, lid TEXT, phone TEXT, name TEXT, push_name TEXT,
    updated_ts INTEGER NOT NULL)`);
  const ins = seed.prepare(`INSERT INTO contacts VALUES (?,?,?,?,?,?)`);
  ins.run(LID, LID, PHONE, NAME, 'ali', 100);
  ins.run(PHONE, LID, PHONE, NAME, 'ali', 100);
  ins.run('971500000002', null, '971500000002', 'Sara', null, 100);
  seed.close();
}

const { default: S, recordInbound, contactChanged, db } = await import('./db.js');

let n = 0;
const check = (label, fn) => { fn(); n += 1; console.log(`  ✓ ${label}`); };

check('migration folds both id rows into one person', () => {
  assert.equal(S.contactCount.get().c, 2, 'Ali and Sara, not four rows');
});

check('both ids still point at that person', () => {
  const keys = db.prepare(
    `SELECT k.key FROM contact_keys k JOIN contacts c ON c.id = k.contact_id
     WHERE c.phone = ? ORDER BY k.key`).all(PHONE).map((r) => r.key);
  assert.deepEqual(keys, [LID, PHONE].sort());
});

check('no number is stored twice', () => {
  const dupes = db.prepare(
    `SELECT phone FROM contacts WHERE phone IS NOT NULL
     GROUP BY phone HAVING COUNT(*) > 1`).all();
  assert.deepEqual(dupes, []);
});

// The whole point of the alias table: a message carries whichever id WhatsApp
// chose, and the name has to resolve either way.
check('a name resolves from a LID-form sender', () => {
  recordInbound({ chatId: `${LID}@lid`, messageId: 'm-lid', senderId: `${LID}@lid`,
    body: 'hi', timestamp: 200 });
  assert.equal(S.message.get('m-lid').sender_display, NAME);
});

check('a name resolves from a phone-form sender', () => {
  recordInbound({ chatId: `${PHONE}@s.whatsapp.net`, messageId: 'm-pn',
    senderId: `${PHONE}@s.whatsapp.net`, body: 'hi', timestamp: 201 });
  assert.equal(S.message.get('m-pn').sender_display, NAME);
});

check('the chat list resolves the same person once', () => {
  const rows = S.chatList.all().filter((c) => c.display_name === NAME);
  assert.equal(rows.length, 2, 'two chats, one per id form');
  assert.ok(rows.every((r) => r.contact_phone === PHONE));
});

// Re-syncing must not create a second person, whichever id it arrives under.
check('re-syncing an existing contact adds no row', () => {
  const before = S.contactCount.get().c;
  S.upsertContact(LID, LID, PHONE, NAME, 'ali', 300);
  S.upsertContact(PHONE, LID, PHONE, NAME, 'ali', 300);
  assert.equal(S.contactCount.get().c, before);
});

// A chat with a stranger creates a phone-only person; their LID shows up later
// and must attach rather than start a second row.
check('a late LID merges into the existing person', () => {
  S.upsertContact('971500000003', null, '971500000003', null, 'Omar', 400);
  const before = S.contactCount.get().c;
  S.upsertContact('444455556666', '444455556666', '971500000003', 'Omar S', null, 401);
  assert.equal(S.contactCount.get().c, before, 'merged, not duplicated');
  const row = db.prepare(`SELECT * FROM contacts WHERE phone = ?`).get('971500000003');
  assert.equal(row.lid, '444455556666');
  assert.equal(row.name, 'Omar S');
});

check('identical name and number is skipped on write', () => {
  assert.equal(contactChanged({ name: NAME, phone: PHONE }, { name: NAME, phone: PHONE }), false);
  assert.equal(contactChanged(undefined, { name: NAME, phone: PHONE }), true);
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`✅ contacts: ${n}/${n} — one row per person, both ids resolve`);
