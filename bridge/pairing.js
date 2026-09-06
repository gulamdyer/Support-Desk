/** When an unpaired bridge may open another pairing socket.
 *
 *  An unscanned QR session lives about four minutes, closes with 428, and the
 *  bridge opens another one. Left unattended that is roughly 180 pairing
 *  sessions and a thousand QR codes a night from a single IP — and unattended
 *  volume is exactly what WhatsApp answers with "Can't link new devices right
 *  now. Try again later." The QR is only useful while somebody is looking at
 *  it, so pairing is demand-driven: an admin opens the window, the UI polling
 *  for the QR holds it open, and it closes on its own once they walk away.
 *
 *  A registered session is a different case entirely and always reconnects —
 *  that is the inbox staying online, not a pairing attempt.
 */
export function pairingActive({ registered, pairingUntil = 0, pairOnly = false, now = Date.now() }) {
  if (registered) return true;   // a linked phone must always come back
  if (pairOnly) return true;     // `npm run link` runs until the operator scans
  return now < pairingUntil;
}
