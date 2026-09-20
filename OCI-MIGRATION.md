# Moving attachments to OCI Object Storage

The data volume fills because nothing ever deletes an attachment. This moves the
bytes to an OCI bucket in Dubai (`me-dubai-1`) and leaves the rest of the app
alone.

Status: **code written, not yet cut over.** `MEDIA_STORE` defaults to `disk`, so
until you set it to `oci` nothing about production behaviour changes.

---

## What actually changes

Attachment bytes are touched in exactly four places. Everything else in the app
reads the `messages.media_path` column, and every one of those readers only ever
uses the **basename** — the UI does `media_path.split('/').pop()`, search does
`replace(media_path, 'data/media/', '')`, the duplicate-attachment gate compares
the string to itself.

So `media_path` keeps the **same shape in both modes**. No DB migration, no
change to search, forwarding, rotation or the gate.

| # | Where | Disk mode | OCI mode |
|---|---|---|---|
| 1 | `bridge/bridge.js` inbound download | writes to `data/media/` | PUT to bucket |
| 2 | `src/server.js` agent upload | writes to `data/media/` | PUT to bucket |
| 3 | `src/server.js` `GET /media/:file` | `res.sendFile` | streams from bucket |
| 4 | `bridge/bridge.js` `/send-media` | `readFileSync` | GET from bucket |

Reads are **proxied through the app**, not redirected to the bucket. A
pre-authenticated URL is a bearer token — redirecting the browser to one would
serve attachments to anyone holding the link and break the property the README
states (*"served only to signed-in agents, with nosniff"*). Same-region traffic
is free, so proxying costs nothing real.

No SDK. A bucket PAR is a URL you GET/PUT/DELETE against, so `src/media-store.js`
is plain `fetch` with zero dependencies, and both containers import it.

---

## Environment variables

Set these in Coolify on **both** the `inbox` and `bridge` services. They are
separate containers off one image; setting them on only one is the most likely
way to get a half-working cutover.

| Variable | Default | Meaning |
|---|---|---|
| `MEDIA_STORE` | `disk` | `disk` = today's behaviour. `oci` = bucket-backed. |
| `MEDIA_PAR` | — | Bucket pre-authenticated request URL, ending `/o/`. Required when `oci`. |
| `MEDIA_QUOTA_GB` | `0` | Allocation shown in the Storage panel. `1024` = 1 TB. Display only. |

`MEDIA_STORE` and `MEDIA_PAR` are needed by **both** services. `MEDIA_QUOTA_GB`
is only read by the inbox, which draws the panel — harmless to set on both.

`MEDIA_STORE=oci` without `MEDIA_PAR` refuses to boot on purpose — the
alternative is every attachment silently 404ing in production.

---

## Runbook

### 1. Deploy the code — no behaviour change

`MEDIA_STORE` is unset, so it defaults to `disk`. Deploy, confirm the inbox is
normal, and let it sit. This step is reversible by being a no-op.

```bash
npm test          # includes the new media-store checks
```

### 2. Create the bucket

OCI Console → Storage → Buckets → Create Bucket, in **me-dubai-1**:

- Name: `wa-media`
- Tier: **Standard**
- Visibility: **Private**
- Versioning: **Disabled**
- Auto-tiering: Disabled
- **Do not create a lifecycle policy.** That is the only thing that would ever
  delete an object. Without one, files live forever.

### 3. Create the PAR

Bucket → Pre-Authenticated Requests → Create:

- Target: **Bucket**
- Access: **Permit object reads and writes**
- **Enable Object Listing: yes** — the Storage panel needs it to total usage
- Expiry: set it decades out (e.g. `2099-01-01`). There is no maximum.

Copy the URL immediately — **OCI shows it exactly once.** It looks like:

```
https://objectstorage.me-dubai-1.oraclecloud.com/p/<secret>/n/<namespace>/b/wa-media/o/
```

> The PAR expiring would stop *access*, not delete data. Your files are
> unaffected either way; you would just paste in a new PAR.

Treat the URL as a password: anyone holding it can read and write the bucket.
Put it straight into Coolify's environment UI. It does not belong in the repo,
in a chat transcript, or in a ticket.

### 4. Backfill

On the instance. The OCI CLI ships on OCI compute images.

> **Prerequisite:** `--auth instance_principal` only works if a dynamic group
> containing this instance *and* a policy granting it `manage objects` in the
> bucket's compartment already exist. Instance principals mean no keys to
> store — not no setup. If that isn't configured, use the PAR route below.

```bash
cd /path/to/app
find data/media -type f | wc -l          # note this number

oci os object bulk-upload \
  -bn wa-media \
  --src-dir data/media \
  --parallel-upload-count 20 \
  --auth instance_principal
```

No instance principal configured? The PAR is already a write credential, so it
can do the backfill by itself — no IAM, no keys:

```bash
export MEDIA_PAR='https://.../o/'        # same value the app uses
find data/media -type f -printf '%f\0' \
  | xargs -0 -P 16 -I{} curl -sf -X PUT -T data/media/{} "$MEDIA_PAR{}"
```

That fallback does no URL-encoding, so check for filenames with spaces first —
agent uploads can contain them, and those need the `oci` CLI (which encodes
properly) or they will 404 when opened:

```bash
find data/media -name '* *' | wc -l      # expect 0 before using the curl route
```

9.4 GB same-region finishes in minutes either way. The directory is flat, so
object names come out as bare basenames — exactly what the app asks for.

### 5. Cut over

Set on **both** services in Coolify, then redeploy:

```
MEDIA_STORE=oci
MEDIA_PAR=https://objectstorage.me-dubai-1.oraclecloud.com/p/.../o/
MEDIA_QUOTA_GB=1024
```

### 6. Sweep the gap

Between step 4 and step 5, inbound media kept landing on disk only. **Skip this
and those files break silently weeks later.**

```bash
oci os object bulk-upload \
  -bn wa-media --src-dir data/media \
  --no-overwrite --parallel-upload-count 20 --auth instance_principal
```

### 7. Test with the disk still present

Proves the deploy didn't regress anything. Full checklist below.

### 8. Test with the disk out of the way — the one that matters

Reads are disk-first, so step 7 was still being served locally. Take the disk
away and the bucket has to do the work:

```bash
mv data/media data/media.bak
```

Run the checklist again. **Rollback is one command:** `mv data/media.bak data/media`.

### 9. Soak, then reclaim

Leave it renamed for an hour if space is tight, a day if it isn't. Then:

```bash
rm -rf data/media.bak
```

Object count should match what you noted in step 4:

```bash
oci os object list -bn wa-media --all --auth instance_principal | grep -c '"name"'
```

---

## Verification checklist

One per chokepoint — anything less isn't a real test.

- [ ] Someone sends an **image**, a **voice note** and a **PDF** → all render
- [ ] An agent **sends an attachment out** — *most likely to break*, it crosses
      both containers (server PUTs → bridge GETs → WhatsApp)
- [ ] Open an attachment from **months ago** → proves the backfill
- [ ] **Forward an old attachment** to another chat → best single test: a
      backfilled object through the gate and the bridge read-back in one action
- [ ] **Seek a video** → proves `Range` forwarding (206 / Content-Range)
- [ ] Open a **PDF inline**, then download it → proves the header logic
- [ ] **Rotate** a card, reload → rotation still sticks
- [ ] Storage panel shows bucket usage against the 1 TB allocation

If the bridge can't read a file back, `MEDIA_PAR` is almost certainly missing on
the **bridge** service.

---

## Rollback

| When | How |
|---|---|
| Any time before step 9 | `MEDIA_STORE=disk`, redeploy |
| After step 8's rename | also `mv data/media.bak data/media` |
| After step 9 | restore from the bucket — it is now the only copy |

---

## The 1 TB allocation

OCI *can* enforce a real cap
([quotas](https://docs.oracle.com/en-us/iaas/Content/Quotas/Concepts/resourcequotas_topic-Object_Storage_Quotas.htm)):

```
Set object-storage quota storage-bytes to 1099511627776 in compartment <X>
```

**Do not set it at 1 TB.** A hard quota makes writes *fail* at the boundary, and
inbound WhatsApp media would be lost — a customer's photo gone for good. If you
want runaway protection, set it at ~1.2 TB as a ceiling that should never be hit.

The 1 TB the client is billed for is `MEDIA_QUOTA_GB`, a display number.

## Cost

Standard tier is **$0.0255/GB/month**, no request charges, 10 TB/month egress
free — and reads from a Dubai instance to a Dubai bucket are same-region anyway.

| Scenario | Stored | Per year |
|---|---|---|
| Today | 9.43 GB | **~$2.90** |
| Doubles over the year | ~14 GB avg | ~$4.30 |
| If the full 1 TB were ever used | 1,024 GB | ~$313 |

OCI bills what you **store**, not what you allocate. The allocation is free.

---

## Known ceilings

- **Usage totalling lists every object** (1000 per request, ~31 calls at current
  volume, cached 10 min). Fine at tens of thousands; swap for `GetBucket`
  `approximateSize` with instance principals if the object count ever explodes.
- **The PAR is a long-lived bearer secret.** It is server-side only, scoped to
  one bucket, and cannot list the tenancy. The zero-secret alternative is
  instance principals with signed REST calls — ~80 lines of crypto plus token
  refresh, or the SDK. Not worth it here.
- **Filenames are 6 random bytes**, so across 30,400 files there is a ~0.2%
  chance two collide. A flat bucket behaves exactly like the flat directory does
  today — pre-existing, not introduced here.
