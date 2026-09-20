/** The storage switch. Disk mode must stay byte-identical to what the app has
 *  always done; OCI mode must build the right URLs and walk every page of a
 *  listing. Both modes read their config at import, so each gets its own
 *  module instance via a query suffix. */
import assert from 'node:assert';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// --- disk mode: unchanged behaviour ---------------------------------------
process.env.MEDIA_STORE = 'disk';
const disk = await import('./media-store.js?disk');
const dir = mkdtempSync(path.join(tmpdir(), 'media-store-'));
const filePath = path.join(dir, 'scan 1.pdf');

assert.equal(disk.isOci(), false);
assert.equal(await disk.saveMedia(filePath, Buffer.from('hello')), filePath,
  'media_path must come back unchanged');
assert.equal(readFileSync(filePath, 'utf8'), 'hello');
assert.equal(await disk.loadMedia('scan 1.pdf'), null, 'disk mode never reaches a bucket');
assert.equal(await disk.openMedia('scan 1.pdf'), null);
await disk.removeMedia(filePath);
assert.ok(!existsSync(filePath), 'a rejected file is deleted, not left behind');

// --- oci mode --------------------------------------------------------------
process.env.MEDIA_STORE = 'oci';
process.env.MEDIA_PAR = 'https://obj.example.com/p/secret/n/ns/b/wa-media/o'; // no trailing slash on purpose
process.env.MEDIA_QUOTA_GB = '1024';

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push([String(url), init.method || 'GET', init.headers]);
  if (String(url).includes('fields=')) {
    const second = String(url).includes('start=page2');
    return {
      ok: true,
      json: async () => (second
        ? { objects: [{ name: 'c', size: 5 }] }
        : { objects: [{ name: 'a', size: 10 }, { name: 'b', size: 20 }], nextStartWith: 'page2' }),
    };
  }
  return { ok: true, arrayBuffer: async () => new TextEncoder().encode('bytes').buffer };
};

const oci = await import('./media-store.js?oci');
assert.equal(oci.isOci(), true);
assert.equal(oci.quotaBytes(), 1024 * 1073741824);

// The PAR had no trailing slash, and the name has a space in it.
const stored = await oci.saveMedia('/app/data/media/scan 1.pdf', Buffer.from('x'));
assert.equal(stored, '/app/data/media/scan 1.pdf', 'media_path keeps the same shape in OCI mode');
assert.deepEqual(calls.at(-1).slice(0, 2),
  ['https://obj.example.com/p/secret/n/ns/b/wa-media/o/scan%201.pdf', 'PUT']);
assert.ok(!existsSync('/app/data/media/scan 1.pdf'), 'OCI mode must not touch the disk');

assert.equal((await oci.loadMedia('img_1.jpg')).toString(), 'bytes');
assert.equal(calls.at(-1)[1], 'GET');

// Range keeps seeking working; the validators let the bucket answer 304 instead
// of resending an attachment the browser already has. Empty ones are dropped.
await oci.openMedia('vid_1.mp4', {
  range: 'bytes=0-99', 'if-none-match': '"abc"', 'if-modified-since': undefined,
});
assert.deepEqual(calls.at(-1)[2], { range: 'bytes=0-99', 'if-none-match': '"abc"' },
  'Range and cache validators must reach the bucket');

await oci.removeMedia('/app/data/media/img_1.jpg');
assert.equal(calls.at(-1)[1], 'DELETE');

// Pagination: both pages counted, not just the first.
assert.deepEqual(await oci.ociUsage(), { bytes: 35, files: 3 });

// 304 is not "missing". It sits outside the 2xx range, so a naive res.ok check
// turns every revalidation into a 404 and the browser re-downloads everything.
globalThis.fetch = async (u, init = {}) => ({
  ok: false,
  status: init.headers?.["if-none-match"] ? 304 : 404,
});
assert.equal((await oci.openMedia("img_1.jpg", { "if-none-match": "\"x\"" }))?.status, 304,
  "a 304 must come back so the route can pass it through");
assert.equal(await oci.openMedia("gone.jpg"), null, "a real miss must still be null");

// A bucket that refuses to list must say so rather than report zero — that
// number is what a client gets billed against.
globalThis.fetch = async () => ({ ok: false, status: 404 });
await assert.rejects(() => oci.ociUsage(), /listing failed/i);

// A failing bucket must never lose the bytes. The bridge downloads media inside
// a catch that only logs, so a throw here would silently record a message with
// no attachment — the photo gone for good. It lands on disk instead.
globalThis.fetch = async () => { throw new Error('network down'); };
const rescued = path.join(dir, 'img_rescued.jpg');
assert.equal(await oci.saveMedia(rescued, Buffer.from('bytes')), rescued);
assert.equal(readFileSync(rescued, 'utf8'), 'bytes',
  'a failed bucket write must fall back to disk, not throw');

// OCI mode with no PAR must refuse to boot. A blank value normalising to '/'
// once slipped past this check, which meant every attachment resolved to a
// relative URL and only failed when an agent opened one.
delete process.env.MEDIA_PAR;
await assert.rejects(() => import('./media-store.js?nopar'), /MEDIA_PAR/,
  'oci mode without a PAR must fail at boot, not at read time');

console.log('✅ media-store: disk mode unchanged, OCI urls/range/pagination correct, boot guard fires');
