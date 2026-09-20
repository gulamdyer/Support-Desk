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

**Verify it before depending on it.** This catches the Object Listing checkbox,
which is easy to miss and is what the storage panel needs:

```bash
export MEDIA_PAR='https://.../o/'

echo hello > /tmp/par-test.txt
curl -sf -X PUT -T /tmp/par-test.txt "${MEDIA_PAR}par-test.txt" && echo "write OK"
curl -sf "${MEDIA_PAR}par-test.txt"                             && echo "read OK"
curl -sf "${MEDIA_PAR}?fields=name,size&limit=1" >/dev/null     && echo "listing OK"
```

All three must print OK. There is deliberately no DELETE here: a PAR cannot
delete objects. Remove the test file with the console or the CLI:

```bash
oci os object delete -bn wa-media --object-name par-test.txt --auth instance_principal
```

### 4. Backfill

On the instance, **from the host** — not inside a container. The app image is
Alpine with no `curl`, and `data/media` is a Docker named volume, so there is no
such directory next to the app. Find the real one first:

```bash
docker volume ls | grep data
export MEDIA_ROOT="$(docker volume inspect <volume> --format '{{.Mountpoint}}')/media"
ls "$MEDIA_ROOT" | head
```

**The OCI CLI is not on every image** — it was missing on this one. Either
install it, or skip it and use the PAR route below, which needs nothing:

```bash
bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"
```

> **Prerequisite:** `--auth instance_principal` only works if a dynamic group
> containing this instance *and* a policy granting it `manage objects` in the
> bucket's compartment already exist. Instance principals mean no keys to
> store — not no setup. If that isn't configured, use the PAR route below.

```bash
cd "$MEDIA_ROOT"
find . -type f | wc -l                   # note this number

oci os object bulk-upload \
  -bn wa-media \
  --src-dir . \
  --parallel-upload-count 20 \
  --auth instance_principal
```

No instance principal configured? The PAR is already a write credential, so it
can do the backfill by itself — no IAM, no keys.

Object names have to be URL-encoded, or the ~500 agent uploads with spaces in
them land under mangled names and 404 when opened. Both sanitisers reduce
filenames to `[A-Za-z0-9_. -]`, so a space is the *only* character that ever
needs encoding — `sed` covers it, and it matches the `encodeURIComponent` the
app uses to read them back:

```bash
export MEDIA_PAR='https://.../o/'        # same value the app uses
cd "$MEDIA_ROOT"
find . -type f -printf '%f\0' \
  | xargs -0 -P 16 -I{} sh -c \
      'curl -sf -X PUT -T "$1" "$MEDIA_PAR$(printf %s "$1" | sed "s/ /%20/g")" \
         || echo "FAILED: $1"' _ {}
```

Any `FAILED:` lines are the files to re-run. Silence means everything landed.

9.4 GB same-region finishes in minutes either way. The directory is flat, so
object names come out as bare basenames — exactly what the app asks for.

**Count what actually landed** before trusting the backfill. Without the CLI,
page the listing through the PAR:

```bash
python3 - <<'EOF'
import os, json, urllib.parse, urllib.request
par = os.environ["MEDIA_PAR"]
if not par.endswith("/"): par += "/"
total, start = 0, ""
while True:
    u = par + "?fields=name&limit=1000" + ("&start=" + urllib.parse.quote(start) if start else "")
    page = json.load(urllib.request.urlopen(u))
    total += len(page.get("objects", []))
    start = page.get("nextStartWith")
    if not start: break
print("objects in bucket:", total)
EOF
```

It must equal the `find ... | wc -l` count from the start of this step. A
shortfall is almost always the space-encoding problem above.

A matching count is still not proof — the files could be there under names the
app will never ask for. Fetch one with a space in it, encoded the way the app
encodes it:

```bash
cd "$MEDIA_ROOT"
sample=$(find . -name '* *' -type f -printf '%f\n' | head -1)
enc=$(printf %s "$sample" | sed 's/ /%20/g')
echo "$sample  ->  $enc"
curl -s -o /dev/null -w 'HTTP %{http_code}\n' "${MEDIA_PAR}${enc}"
```

`HTTP 200` means the stored names match what the app will request. Anything
else and those files are present but unreachable.

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

Mark the moment the backfill finished, so the sweep only carries what arrived
after it instead of re-uploading 9.4 GB:

```bash
touch /root/backfill-done      # the moment step 4 completes
```

With the CLI:

```bash
cd "$MEDIA_ROOT"
oci os object bulk-upload -bn wa-media --src-dir . \
  --no-overwrite --parallel-upload-count 20 --auth instance_principal
```

Or through the PAR, carrying only what is newer than the marker:

```bash
cd "$MEDIA_ROOT"
find . -type f -newer /root/backfill-done -printf '%f\0' \
  | xargs -0 -P 16 -I{} sh -c \
      'curl -sf -X PUT -T "$1" "$MEDIA_PAR$(printf %s "$1" | sed "s/ /%20/g")" \
         || echo "FAILED: $1"' _ {}
```

Recount afterwards: it must equal `find . -type f | wc -l` plus any stray test
objects.

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

### Proving it is really the bucket

The page will show `<img src="/media/img_….jpg">` in both modes. That is **by
design, not evidence of the disk**: the bucket URL and the PAR never reach the
browser, because a PAR is a bearer token and anyone holding it could read the
whole bucket. Seeing an `objectstorage…` URL in the DOM would be the bug.

So the browser cannot tell you which backend served a file. Two things can:

**Conclusive — the directory is gone.** After step 8 there is no
`/app/data/media` in the container, so anything that still renders came from
the bucket:

```bash
docker exec <inbox-container> ls -la /app/data/
```

**Spot-check — compare ETags.** Ask the bucket directly, server-side, so
nothing is exposed:

```bash
curl -sI "${MEDIA_PAR}<object-name>" | grep -i etag
```

Match it against the `ETag` in DevTools → Network → that image → Response
Headers. Identical means the browser's bytes came from Dubai. The shape gives
it away on its own: `res.sendFile` emits a **weak** validator (`W/"b-1a0be…"`,
size and mtime), while Object Storage returns a **strong** one with no `W/`.

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
- **A PAR cannot delete objects.** Oracle's own security design: a leaked URL
  can never destroy data. So the upload route asks the gate *before* storing
  bytes rather than storing and cleaning up after. Housekeeping deletes need
  the console or the CLI, not the app.
- **The PAR is a long-lived bearer secret.** It is server-side only, scoped to
  one bucket, and cannot list the tenancy. The zero-secret alternative is
  instance principals with signed REST calls — ~80 lines of crypto plus token
  refresh, or the SDK. Not worth it here.
- **Filenames are 6 random bytes**, so across 30,400 files there is a ~0.2%
  chance two collide. A flat bucket behaves exactly like the flat directory does
  today — pre-existing, not introduced here.
