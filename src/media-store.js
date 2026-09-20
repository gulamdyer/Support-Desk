/** Where attachment bytes live.
 *
 *  MEDIA_STORE=disk (the default) is exactly the behaviour this app has always
 *  had: files on the data volume, served off it. MEDIA_STORE=oci puts them in an
 *  OCI Object Storage bucket instead and leaves everything else alone — the
 *  media_path column keeps the same shape in both modes, so the UI, search, the
 *  duplicate-attachment gate and forwarding never learn the difference.
 *
 *  Reads are proxied through the app, never redirected to the bucket. A
 *  pre-authenticated URL is a bearer token: handing one to the browser would
 *  serve attachments to anyone with the link, and these are only ever for
 *  signed-in agents.
 *
 *  No SDK on purpose. A bucket PAR is a URL you GET/PUT/DELETE against, so the
 *  whole integration is fetch() and this file has no dependencies — which is
 *  also why both the inbox and the bridge can import it.
 */
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const MODE = (process.env.MEDIA_STORE || 'disk').toLowerCase();
// The PAR ends at .../o/ and the object name goes straight on the end. The
// empty case needs guarding: ''.replace(/\/*$/, '/') is '/', which would slip
// past the boot check below and turn every object URL into a relative path —
// failing at read time in production rather than at startup.
const PAR = process.env.MEDIA_PAR ? process.env.MEDIA_PAR.replace(/\/*$/, '/') : '';

export const isOci = () => MODE === 'oci';
/** Allocation shown in the storage panel. Display only — a hard cap would make
 *  inbound media fail at the boundary, losing a customer's photo for good. */
export const quotaBytes = () => Number(process.env.MEDIA_QUOTA_GB || 0) * 1073741824;

// Fail at boot rather than 404 every attachment in production.
if (isOci() && !PAR) {
  throw new Error('MEDIA_STORE=oci needs MEDIA_PAR (the bucket pre-authenticated request URL).');
}

// Names carry spaces — an agent's "scan 1.pdf" — so always encode.
const objectUrl = (name) => PAR + encodeURIComponent(name);
const call = (name, init) =>
  fetch(objectUrl(name), { ...init, signal: AbortSignal.timeout(30000) });

/** Store bytes and return the string to put in messages.media_path. Same shape
 *  in both modes: that sameness is what keeps the rest of the app ignorant. */
export async function saveMedia(diskPath, buf) {
  if (isOci()) {
    try {
      const res = await call(path.basename(diskPath), { method: 'PUT', body: buf });
      if (!res.ok) throw new Error(`bucket returned ${res.status}`);
      return diskPath;
    } catch (err) {
      // Never lose a customer's photo to a bad PAR or a network blip. The
      // bridge downloads media inside a try/catch that only logs, so throwing
      // here would record the message with no attachment at all and the bytes
      // would be gone for good. Fall through to the disk instead — the reader
      // checks there first anyway, and the next backfill sweep collects it.
      console.error(`[media] bucket write failed (${err.message}); kept on disk: ${path.basename(diskPath)}`);
    }
  }
  mkdirSync(path.dirname(diskPath), { recursive: true });
  writeFileSync(diskPath, buf);
  return diskPath;
}

/** Whole file as a Buffer, for the bridge handing it to WhatsApp.
 *  null means "not here" — in disk mode that is always, and the caller falls
 *  back to the local file it already found. */
export async function loadMedia(name) {
  if (!isOci()) return null;
  const res = await call(name);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

/** Streamed read for GET /media/:file. `headers` are forwarded verbatim, so
 *  Range keeps video seeking working and the cache validators let the bucket
 *  answer 304 instead of resending bytes the browser already has. Returns the
 *  upstream Response, or null when genuinely absent.
 *
 *  304 is explicitly allowed through: it sits outside the 2xx range, so
 *  res.ok is false for it, and treating that as "missing" would turn every
 *  revalidation into a 404. */
export async function openMedia(name, headers = {}) {
  if (!isOci()) return null;
  const send = Object.fromEntries(Object.entries(headers).filter(([, v]) => v));
  const res = await call(name, Object.keys(send).length ? { headers: send } : undefined);
  if (!res.ok && res.status !== 304) return null;
  return res;
}

/** A file the gate rejected. On disk this removes it; against a bucket it will
 *  not, because a PAR cannot delete objects — deliberate, so that a leaked URL
 *  can never destroy data. That is exactly why the upload route asks the gate
 *  before storing anything, leaving this for the rare race where a file is
 *  refused after the bytes already landed. A stray object costs a fraction of a
 *  cent, and failing an agent's send over it would be worse. */
export async function removeMedia(diskPath) {
  if (!isOci()) {
    try { unlinkSync(diskPath); } catch {}
    return;
  }
  try { await call(path.basename(diskPath), { method: 'DELETE' }); } catch {}
}

/** What the bucket holds, for the storage panel. That panel is the number a
 *  client gets billed against, so this measures what OCI actually charges for
 *  rather than a counter we keep and hope stays true.
 *
 *  ponytail: lists every object, 1000 per request — ~31 calls at current volume
 *  and the caller caches it. Swap for GetBucket approximateSize (needs instance
 *  principals and request signing) if the object count ever explodes.
 */
export async function ociUsage() {
  let bytes = 0;
  let files = 0;
  // Backups share the bucket but are not attachments. Counting them here would
  // inflate the figure the panel labels "Attachments" — and that figure is what
  // a client gets billed against.
  for (const o of await listObjects()) {
    if (o.name?.startsWith(BACKUP_PREFIX)) continue;
    bytes += o.size || 0;
    files += 1;
  }
  return { bytes, files };
}

// --- anything that is not a chat attachment -------------------------------
// Backups live in the same bucket under their own prefix. One bucket, one PAR,
// one lifecycle rule to age them out — and nothing new to configure.
export const BACKUP_PREFIX = 'backups/';

/** Every object, or every object under a prefix. Pages at 1000 a time. */
export async function listObjects(prefix = '') {
  const out = [];
  let start = '';
  for (;;) {
    const q = new URLSearchParams({ fields: 'name,size,timeCreated', limit: '1000' });
    if (prefix) q.set('prefix', prefix);
    if (start) q.set('start', start);
    const res = await fetch(`${PAR}?${q}`, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      throw new Error(`Bucket listing failed (${res.status}). Enable Object Listing on the PAR.`);
    }
    const page = await res.json();
    out.push(...(page.objects || []));
    start = page.nextStartWith || '';
    if (!start) return out;
  }
}

/** Store bytes under an exact object name. saveMedia derives its name from a
 *  disk path; a backup needs to say where it goes. */
export async function putObject(name, buf) {
  if (!isOci()) throw new Error('MEDIA_STORE is not oci — there is no bucket to upload to.');
  const res = await call(name, { method: 'PUT', body: buf });
  if (!res.ok) throw new Error(`Bucket rejected ${name} (${res.status}).`);
}

/** One object as a Buffer, or null if it is not there. */
export async function getObject(name) {
  if (!isOci()) return null;
  const res = await call(name);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}
