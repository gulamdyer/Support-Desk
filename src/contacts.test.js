/** Contact sync dedupe — the guard that stops the address book being rewritten
 *  on every 5-minute pass, and stops a second sync duplicating what is stored. */
import assert from 'node:assert';
import { contactChanged } from './db.js';

let n = 0;
const check = (label, fn) => { fn(); n += 1; console.log(`  ✓ ${label}`); };

// A contact nobody has stored yet has to be written.
check('new contact is written', () => {
  assert.equal(contactChanged(undefined, { key: '9714', name: 'Ali', phone: '9714' }), true);
});

// The same name and the same number: nothing to do. This is the case the whole
// guard exists for — every pass re-sends the entire address book.
check('identical name and number is skipped', () => {
  const prev = { key: '9714', name: 'Ali', phone: '9714' };
  assert.equal(contactChanged(prev, { key: '9714', name: 'Ali', phone: '9714' }), false);
});

check('renamed contact is written', () => {
  const prev = { key: '9714', name: 'Ali', phone: '9714' };
  assert.equal(contactChanged(prev, { key: '9714', name: 'Ali Hassan', phone: '9714' }), true);
});

// A LID-only record that later learns its real number must still be written,
// otherwise the number never resolves and the UI keeps showing a masked LID.
check('newly resolved phone number is written', () => {
  const prev = { key: '812', name: 'Ali', phone: null };
  assert.equal(contactChanged(prev, { key: '812', name: 'Ali', phone: '9714' }), true);
});

// undefined and null mean the same thing here; treating them as different would
// rewrite every nameless row forever.
check('missing name matches a stored null', () => {
  const prev = { key: '9714', name: null, phone: '9714' };
  assert.equal(contactChanged(prev, { key: '9714', phone: '9714' }), false);
});

console.log(`✅ contacts: ${n}/${n} — dedupe on name + number`);
