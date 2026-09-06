/** The pairing window — the guard that stopped the all-night QR loop.
 *
 *  Regression cover for 2026-09-06: an unlinked bridge reopened a pairing
 *  session every few minutes for twelve hours, and WhatsApp began refusing to
 *  link the phone at all.
 */
import assert from 'node:assert';
import { pairingActive } from './pairing.js';

const NOW = 1_000_000;
let n = 0;
const check = (label, fn) => { fn(); n += 1; console.log(`  ✓ ${label}`); };

check('a linked session always reconnects', () => {
  // Nothing here may ever stop the inbox coming back online.
  assert.equal(pairingActive({ registered: true, pairingUntil: 0, now: NOW }), true);
});

check('an admin who just asked to link gets QR codes', () => {
  assert.equal(pairingActive({ registered: false, pairingUntil: NOW + 60_000, now: NOW }), true);
});

check('an unwatched bridge stops opening pairing sessions', () => {
  // The bug: this returned true forever.
  assert.equal(pairingActive({ registered: false, pairingUntil: NOW - 1, now: NOW }), false);
});

check('a bridge nobody ever asked stays quiet', () => {
  // Boot and redeploy land here — no window was ever opened.
  assert.equal(pairingActive({ registered: false, now: NOW }), false);
});

check('the window expires exactly at its deadline', () => {
  assert.equal(pairingActive({ registered: false, pairingUntil: NOW, now: NOW }), false);
  assert.equal(pairingActive({ registered: false, pairingUntil: NOW + 1, now: NOW }), true);
});

check('the pairing CLI is not cut off mid-scan', () => {
  assert.equal(pairingActive({ registered: false, pairOnly: true, pairingUntil: 0, now: NOW }), true);
});

console.log(`✅ pairing: ${n}/${n} — QR sessions only while an admin is watching`);
