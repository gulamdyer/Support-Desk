/* Support inbox UI. No framework: the state is small and the DOM is small. */
const $ = (id) => document.getElementById(id);
const api = async (url, body) => {
  const res = await fetch(url, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : {});
  const data = await res.json().catch(() => ({}));
  // A 401 once signed in means the session died under us. Every caller would
  // otherwise surface it as some unrelated-looking failure.
  if (res.status === 401 && me && url !== '/api/login') sessionExpired();
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.field = data.field;   // so the message can land on the input it concerns
    throw err;
  }
  return data;
};

let expired = false;
function sessionExpired(message = 'Your session expired. Please sign in again.') {
  if (expired) return;
  expired = true;
  stream?.close();
  // Dialogs live outside #app, so hiding the app alone would leave one floating
  // over the login screen. Everything closes before the sign-in page appears.
  document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; });
  $('profileMenu').hidden = true;
  $('profileBtn').setAttribute('aria-expanded', 'false');
  $('app').hidden = true;
  $('loginPage').hidden = false;
  setPwVisible(false);
  $('loginErr').textContent = message;
}

let me = null, chats = [], open = null, openWindow = null, filter = '';
let category = 'all', dateFrom = null, dateTo = null;

function toast(text, kind = 'bad') {
  const t = $('toast');
  t.textContent = text; t.className = 'toast ' + kind; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 6000);
}

const timeOf = (ts) => {
  const d = new Date(ts * 1000), today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: '2-digit', month: 'short' });
};
// Bubbles show a clock only; the day separator above them carries the date.
const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// History entries are read days apart, so they carry the date as well as the time.
const when = (ts) => new Date(ts * 1000)
  .toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const dayLabel = (ts) => {
  const d = new Date(ts * 1000), days = Math.round((Date.now() / 1000 - ts) / 86400);
  if (d.toDateString() === new Date().toDateString()) return 'Today';
  if (d.toDateString() === new Date(Date.now() - 86400e3).toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], days < 300
    ? { weekday: 'short', day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
};
const PREVIEW_LABEL = { audio: '🎤 Voice message', image: '📷 Photo', video: '🎬 Video', document: '📎 Document', sticker: '🌟 Sticker' };
const previewText = (p) => {
  const m = /^\[(image|audio|video|document|sticker|media) received\]$/i.exec(p || '');
  return m ? (PREVIEW_LABEL[m[1].toLowerCase()] || '📎 Attachment') : (p || '');
};
// How a customer is identified on screen, decided in one place:
//   saved in the phone's contacts -> the name, and never the number
//   not saved                     -> the last 4 digits only
// Full numbers are deliberately kept off the screen; agents recognise people by
// name, and an unsaved customer by the tail of their number.
const onlyDigits = (v) => String(v || '').replace(/\D/g, '');
const maskNumber = (raw) => {
  const d = onlyDigits(raw);
  return d.length >= 4 ? `*** ${d.slice(-4)}` : '*** ????';
};
const isMasked = (v) => String(v || '').startsWith('*** ');

// Only a name from the linked phone's address book counts.
//   display_name -> that address-book name (server sends nothing else)
//   c.name       -> for GROUPS this is the subject; for 1:1 it may be the
//                   contact's self-chosen pushName, which is NOT a saved name
//                   and must never be shown.
const nameOf = (c) => c.is_group
  ? (c.name || maskNumber(c.id.split('@')[0]))
  : (c.display_name || maskNumber(c.contact_phone || c.id.split('@')[0]));
// Outbound files are stored with a random prefix; show the name the agent picked.
// iPadOS reports itself as a Mac, so touch points are what actually tell them
// apart. Used by both the document viewer and the install prompt.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const extOf = (name) => String(name).toLowerCase().split('.').pop();
/** A document reads as a card, the way it does in WhatsApp: the file's badge,
 *  its name, and its type — not a bare link that only says "attachment". */
function docCard(m, url) {
  const name = fileLabel(m);
  const ext = extOf(name);
  const pdf = ext === 'pdf';
  return `<button class="doc" data-doc="${url}" data-docname="${esc(name)}" data-docpdf="${pdf ? 1 : 0}"
    draggable="true" data-dl="${url}?download=1" data-dlname="${esc(name)}"
    title="${pdf ? 'Open' : 'Download'} ${esc(name)}">
    <span class="doc-icon ${pdf ? 'pdf' : ''}">${esc(ext.slice(0, 4).toUpperCase() || 'FILE')}</span>
    <span class="doc-text"><span class="doc-name">${esc(name)}</span></span>
  </button>`;
}

const MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', txt: 'text/plain', zip: 'application/zip', rar: 'application/vnd.rar',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4',
};
const mimeOf = (name) => MIME[String(name).toLowerCase().split('.').pop()] || 'application/octet-stream';

// Stored names carry an id so two files called invoice.pdf cannot collide on
// disk: outbound is "<8hex>-name", inbound is "doc_<12hex>_name" (or
// "img_<12hex>.jpg" for a photo, which never had a name to begin with). None
// of that is the agent's business — show what the sender actually called it.
const STORED_ID = /^(?:[0-9a-f]{8}-|(?:img|vid|aud|doc|ptt)_[0-9a-f]{8,16}_?)/i;
const KIND_NAME = { image: 'Photo', video: 'Video', audio: 'Voice note', document: 'Document' };

const fileLabel = (m) => {
  const stored = (m.media_path || '').split('/').pop();
  const name = stored.replace(STORED_ID, '');
  // A photo or voice note arrives with no filename, so stripping the id leaves
  // nothing but an extension. Give those something readable to show and to
  // save as, rather than ".jpg".
  if (!name || name.startsWith('.')) {
    const kind = KIND_NAME[m.media_type] || 'Attachment';
    const ext = stored.includes('.') ? extOf(stored) : '';
    return ext ? `${kind}.${ext}` : kind;
  }
  return name;
};
const senderOf = (m) => m.sender_display || maskNumber(m.sender_phone || m.sender_id);
const initials = (name) => (isMasked(name)
  ? onlyDigits(name).slice(-2)
  : name.replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).slice(0, 2)
      .map((w) => w[0]).join('').toUpperCase()) || '#';
// Stable per-chat hue so a face is recognisable at a glance without avatar images.
const hue = (id) => [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
const avatar = (id, name) => `<span class="avatar" style="background:hsl(${hue(id)} 42% 42%)">${esc(initials(name))}</span>`;
const setAvatar = (el, id, name) => { el.textContent = initials(name); el.style.background = `hsl(${hue(String(id))} 42% 42%)`; };
const PLACEHOLDER = /^\[(image|audio|video|document|sticker|media) received\]$/i;
const realBody = (b) => (PLACEHOLDER.test(b || '') ? '' : b);

/** True when a document's caption is just its filename repeated. WhatsApp
 *  sends the name as the caption, so printing the body as well showed it
 *  twice. A caption the sender actually typed is still shown. */
const captionRepeatsName = (m) => {
  if (!m.media_path) return false;
  const body = realBody(m.body).trim().toLowerCase();
  if (!body) return false;
  const name = fileLabel(m).trim().toLowerCase();
  return body === name || body === name.replace(/\.[^.]+$/, '');
};

const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

// --- chat list ----------------------------------------------------------
// All / Personal / Groups / Unassigned, plus an optional activity-date window.
function matchesFilters(c) {
  // Unread means nobody on the team has opened it yet — the same count the
  // badge shows, so the filter and the badge can never disagree.
  if (category === 'unread' && !c.unread) return false;
  if (category === 'personal' && c.is_group) return false;
  if (category === 'group' && !c.is_group) return false;
  if (category === 'unassigned' && c.assigned_to) return false;
  if (dateFrom !== null && c.last_ts < dateFrom) return false;
  if (dateTo !== null && c.last_ts >= dateTo) return false;
  return true;
}

function renderChats() {
  const q = filter.toLowerCase();
  $('chats').innerHTML = chats
    .filter(matchesFilters)
    .filter((c) => !q || nameOf(c).toLowerCase().includes(q) || c.id.includes(q))
    .map((c) => `
      <div class="chat ${c.id === open ? 'on' : ''} ${c.unread ? 'unread' : ''}" data-id="${esc(c.id)}">
        ${avatar(c.id, nameOf(c))}
        <div class="n">${esc(nameOf(c))}${c.is_group ? ' <span class="t">· group</span>' : ''}</div>
        <div class="t">${timeOf(c.last_ts)}</div>
        <div class="p">${c.preview_out ? '↩ ' : ''}${esc(previewText(c.preview).slice(0, 60))}</div>
        ${c.unread ? `<div class="badge">${c.unread}</div>` : '<div></div>'}
        ${c.assignee_name ? `<div class="owner">${esc(c.assignee_name)}${c.assigned_to === me.id ? ' (you)' : ''}</div>` : ''}
      </div>`).join('') || `<div class="list-empty">${
    // An empty Unread list is the good outcome, not a failed search.
    category === 'unread' && !filter && dateFrom === null ? 'Nothing unread — the team is caught up.'
      : filter || category !== 'all' || dateFrom !== null ? 'No conversations match these filters.'
      : 'No conversations yet.'}</div>`;
}

$('chats').onclick = (e) => {
  const el = e.target.closest('.chat');
  if (el) openChat(el.dataset.id);
};
$('search').oninput = (e) => { filter = e.target.value; renderChats(); };

async function loadChats() {
  chats = (await api('/api/chats')).chats;
  renderChats();
}

// --- thread -------------------------------------------------------------
let threadCache = [];
// --- searching inside the open conversation ------------------------------
let findQuery = '', findHits = [], findAt = -1;

// Escape first, then wrap the matches — never the other way round.
function highlight(text) {
  const safe = esc(text);
  if (!findQuery) return safe;
  const needle = esc(findQuery).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(needle, 'gi'), (hit) => `<mark>${hit}</mark>`);
}
function renderMessages(messages, isGroup) {
  threadCache = messages;
  const box = $('messages');
  const stick = box.scrollTop + box.clientHeight > box.scrollHeight - 80;
  let day = '';
  box.innerHTML = messages.map((m) => {
    const d = new Date(m.ts * 1000).toDateString();
    const sep = d === day ? '' : `<div class="day">${dayLabel(m.ts)}</div>`;
    day = d;
    const state = m.status === 'queued' ? '🕓 queued'
      : m.status === 'sending' ? '🕓 sending'
      : m.status === 'failed' ? `<span class="x">⚠ ${esc(m.error || 'failed')}</span><button class="retry" data-retry="${esc(m.id)}">Retry</button>`
      : m.from_me ? '✓ sent' : '';
    const url = m.media_path ? `/media/${encodeURIComponent(m.media_path.split('/').pop())}` : '';
    const media = !m.media_path ? ''
      : m.media_type === 'image' ? `<img src="${url}" alt="" draggable="true" data-dl="${url}?download=1" data-dlname="${esc(fileLabel(m))}">`
      : m.media_type === 'audio' ? `
        <div class="voice" data-src="${url}">
          <button class="voice-play" aria-label="Play voice message">
            <svg class="i-play" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
            <svg class="i-pause" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
          </button>
          <div class="voice-wave"></div>
          <span class="voice-time">0:00</span>
        </div>`
      : docCard(m, url);
    return sep + `<div class="msg ${m.from_me ? 'out' : ''} ${m.status === 'failed' ? 'fail' : ''}">
      <button class="msg-caret" data-menu="${esc(m.id)}" title="Message actions" aria-label="Message actions" aria-haspopup="menu"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
      ${!m.from_me && isGroup && m.sender_id ? `<div class="from">${esc(senderOf(m))}</div>` : ''}
      ${m.from_me && m.agent_name ? `<div class="from">${esc(m.agent_name)}</div>` : ''}
      ${quoteOf(m)}${media}${realBody(m.body) && !captionRepeatsName(m) ? `<span class="body">${highlight(realBody(m.body))}</span>` : ''}
      <div class="meta">${clock(m.ts)} ${state}</div>
    </div>`;
  }).join('');
  if (stick && !findQuery) { autoScrolling += 1; box.scrollTop = box.scrollHeight; }
  setTimeout(() => { autoScrolling = Math.max(0, autoScrolling - 1); }, 0);
  initVoice();
  paintCurrentHit();
  renderPicked();   // the thread is rebuilt wholesale; re-mark what is selected
}

// Dragging an attachment onto the desktop saves it. Chrome reads DownloadURL;
// other browsers ignore it and drag the plain link instead, which still works
// as a link. The file itself is behind the session cookie, and the browser
// sends it because this is a same-site request it makes itself.
$('messages').addEventListener('dragstart', (e) => {
  const el = e.target.closest('[data-dl]');
  if (!el) return;
  const url = new URL(el.dataset.dl, location.href).href;
  // ':' is the field separator in the DownloadURL string, so it cannot survive
  // inside the filename.
  const name = (el.dataset.dlname || 'attachment').replace(/:/g, '-');

  // Dragging an <a> or an <img> puts its URL on the pasteboard automatically,
  // and macOS prefers that flavour: the Finder then writes a .webloc shortcut,
  // or nothing at all, instead of accepting the file Chrome is offering. Clear
  // the URL flavours so the promised download is the only thing on offer.
  e.dataTransfer.clearData();
  e.dataTransfer.setData('DownloadURL', `${mimeOf(name)}:${name}:${url}`);
  e.dataTransfer.effectAllowed = 'copy';
});

// --- viewing an image -----------------------------------------------------
// A licence or a plate number is often the whole message, and it arrives as a
// phone photo: small, sometimes sideways. Zoom and rotate are what make it
// readable without downloading it first.
let zoom = 1, spin = 0, panX = 0, panY = 0;
const pointers = new Map();
let pinchStart = 0, zoomStart = 1;

function applyImgTransform() {
  $('imgView').style.transform = `translate(${panX}px, ${panY}px) scale(${zoom}) rotate(${spin}deg)`;
  $('imgZoom').textContent = `${Math.round(zoom * 100)}%`;
}
function setZoom(next) {
  zoom = Math.min(8, Math.max(0.25, next));
  if (zoom <= 1) { panX = 0; panY = 0; }   // nothing to pan once it fits
  applyImgTransform();
}
function resetImg() { zoom = 1; spin = 0; panX = 0; panY = 0; applyImgTransform(); }

function openImage(url, name) {
  $('imgTitle').textContent = name;
  $('imgView').src = url;
  $('imgView').alt = name;
  $('imgSave').href = `${url}?download=1`;
  $('imgSave').setAttribute('download', name);
  resetImg();
  $('imgModal').hidden = false;
}
const closeImage = () => { $('imgModal').hidden = true; $('imgView').src = ''; pointers.clear(); };

$('imgIn').onclick = () => setZoom(zoom * 1.4);
$('imgOut').onclick = () => setZoom(zoom / 1.4);
$('imgRotate').onclick = () => { spin = (spin + 90) % 360; applyImgTransform(); };
$('imgReset').onclick = resetImg;
$('imgClose').onclick = closeImage;
$('imgModal').onclick = (e) => { if (e.target.id === 'imgModal') closeImage(); };

$('imgStage').addEventListener('wheel', (e) => {
  e.preventDefault();
  setZoom(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
}, { passive: false });
$('imgStage').addEventListener('dblclick', () => setZoom(zoom > 1 ? 1 : 2.5));

// One finger pans, two fingers pinch. Pointer events cover mouse, trackpad and
// touch with the same code, which is the only reason this stays short.
$('imgStage').addEventListener('pointerdown', (e) => {
  $('imgStage').setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  $('imgStage').classList.add('panning');
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
    zoomStart = zoom;
  }
});
$('imgStage').addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  const next = { x: e.clientX, y: e.clientY };
  pointers.set(e.pointerId, next);

  if (pointers.size === 2 && pinchStart) {
    const [a, b] = [...pointers.values()];
    setZoom(zoomStart * (Math.hypot(a.x - b.x, a.y - b.y) / pinchStart));
    return;
  }
  if (zoom <= 1) return;              // it already fits; dragging would do nothing
  panX += next.x - prev.x;
  panY += next.y - prev.y;
  applyImgTransform();
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchStart = 0;
  if (!pointers.size) $('imgStage').classList.remove('panning');
};
$('imgStage').addEventListener('pointerup', endPointer);
$('imgStage').addEventListener('pointercancel', endPointer);

document.addEventListener('keydown', (e) => {
  if ($('imgModal').hidden) return;
  if (e.key === 'Escape') return closeImage();
  // Escape always closes; the single-letter shortcuts must not fire while
  // something behind the viewer still has the caret.
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(zoom * 1.4); }
  if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(zoom / 1.4); }
  if (e.key.toLowerCase() === 'r') { spin = (spin + 90) % 360; applyImgTransform(); }
  if (e.key === '0') resetImg();
});

// --- reading a document ---------------------------------------------------
// A PDF opens in a viewer so an agent can read a licence or certificate in
// place. Anything else still downloads — that is the only safe way to hand
// over a file type the browser might execute.
function openDoc(url, name) {
  $('docTitle').textContent = name;
  $('docOpen').href = url;
  $('docSave').href = `${url}?download=1`;
  $('docSave').setAttribute('download', name);
  // Always try to render. WebKit's PDF support in a frame varies by iOS
  // version — sometimes the whole document, sometimes the first page — and
  // refusing to try on that assumption showed nothing on devices that could
  // have shown something. On iOS the escape hatch sits under the frame rather
  // than replacing it, so a blank result still has a way out.
  $('docFrame').hidden = false;
  $('docFrame').src = url;
  $('docFallback').hidden = !isIOS;
  $('docModal').hidden = false;
}

const closeDoc = () => { $('docModal').hidden = true; $('docFrame').src = 'about:blank'; };
$('docClose').onclick = closeDoc;
$('docModal').onclick = (e) => { if (e.target.id === 'docModal') closeDoc(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('docModal').hidden) closeDoc(); });

$('messages').addEventListener('click', (e) => {
  const img = e.target.closest('.msg img[data-dl]');
  if (img && !picked.size) {
    e.preventDefault();
    return openImage(img.getAttribute('src'), img.dataset.dlname || 'Photo');
  }
  const card = e.target.closest('[data-doc]');
  if (!card || picked.size) return;          // while picking, a tap selects
  e.preventDefault();
  if (card.dataset.docpdf === '1') return openDoc(card.dataset.doc, card.dataset.docname);
  const a = document.createElement('a');
  a.href = `${card.dataset.doc}?download=1`;
  a.download = card.dataset.docname;
  document.body.appendChild(a); a.click(); a.remove();
});

// --- selecting several messages to forward -------------------------------
let picked = new Set();
// share() needs the user gesture that started it, and fetching the files can
// outlive that. So the files are kept after the first tap: if the browser
// refuses because the gesture expired, the second tap shares instantly.
let shareReady = null;   // { key, files, text }

function renderPicked() {
  const on = picked.size > 0;
  $('messages').classList.toggle('picking', on);
  $('pickBar').hidden = !on;
  $('pickShare').hidden = !SHARE_SUPPORTED;
  $('pickCount').textContent = on ? `${picked.size} selected` : '';
  document.querySelectorAll('#messages .msg').forEach((el) => {
    const id = el.querySelector('[data-menu]')?.dataset.menu;
    el.classList.toggle('picked', !!id && picked.has(id));
  });
}

function togglePick(id) {
  if (picked.has(id)) picked.delete(id); else picked.add(id);
  shareReady = null;   // the selection changed, so anything prepared is stale
  renderPicked();
}

const clearPicked = () => { picked = new Set(); shareReady = null; renderPicked(); };

// --- share the selection out of the app -----------------------------------
// The Web Share API hands files to whatever the operating system offers —
// WhatsApp, Mail, Slack, AirDrop. It is only offered where it actually works;
// Firefox has no file sharing, so the button stays hidden there rather than
// promising something that will fail.
const SHARE_MAX = 10;
// Gate on the API existing, not on a synthetic probe. Probing with a made-up
// zero-byte file returned false on WebKit — which rejects empty files — so the
// button was hidden on iPhone even though sharing works there. Whether these
// particular files can be shared is asked at click time, with the real files.
const SHARE_SUPPORTED = typeof navigator.share === 'function';

async function prepareShare(msgs) {
  const key = msgs.map((m) => m.id).join('|');
  if (shareReady?.key === key) return shareReady;
  const files = [];
  for (const m of msgs.filter((x) => x.media_path)) {
    const url = `/media/${encodeURIComponent(m.media_path.split('/').pop())}?download=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not read ${fileLabel(m)}.`);
    const blob = await res.blob();
    files.push(new File([blob], fileLabel(m), { type: blob.type || mimeOf(fileLabel(m)) }));
  }
  const text = msgs.filter((m) => !m.media_path).map((m) => realBody(m.body)).filter(Boolean).join('\n\n');
  shareReady = { key, files, text };
  return shareReady;
}

$('pickShare').onclick = async () => {
  const msgs = [...picked].map(msgById).filter(Boolean);
  if (!msgs.length) return;
  if (msgs.filter((m) => m.media_path).length > SHARE_MAX) {
    return toast(`Share up to ${SHARE_MAX} files at a time.`);
  }
  const btn = $('pickShare');
  const label = btn.textContent;
  btn.disabled = true;
  try {
    btn.textContent = 'Preparing…';
    const { files, text } = await prepareShare(msgs);
    const payload = files.length ? (text ? { files, text } : { files }) : { text };
    if (!text && !files.length) return toast('Nothing to share in that selection.');
    if (!navigator.canShare?.(payload)) throw Object.assign(new Error('unsupported'), { code: 'nofiles' });
    await navigator.share(payload);
    clearPicked();
  } catch (err) {
    if (err?.name === 'AbortError') return;                 // the sheet was dismissed
    if (err?.name === 'NotAllowedError') {
      // The gesture expired while the files were being read; they are held now.
      return toast('Ready — tap Share again to choose an app.');
    }
    if (err?.code === 'nofiles') {
      // Sharing is unavailable for these files — save them instead, which is
      // what the agent was going to do with them anyway.
      const { files } = shareReady || { files: [] };
      files.forEach((f) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(f);
        a.download = f.name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      });
      return toast(files.length ? `Sharing unavailable — downloaded ${files.length} instead.` : 'Nothing to share.');
    }
    toast(err.message || 'Could not share that.');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
};
$('pickCancel').onclick = clearPicked;
$('pickForward').onclick = () => { if (picked.size) openForward([...picked]); };

// While picking, a tap anywhere on a message toggles it rather than opening it.
$('messages').addEventListener('click', (e) => {
  if (!picked.size) return;
  const row = e.target.closest('.msg');
  const id = row?.querySelector('[data-menu]')?.dataset.menu;
  if (!id) return;
  e.preventDefault();
  togglePick(id);
});

function paintCurrentHit() {
  document.querySelectorAll('.msg.hit-on').forEach((el) => el.classList.remove('hit-on'));
  const hit = findHits[findAt];
  if (!hit) return;
  const el = [...document.querySelectorAll('#messages .msg')]
    .find((m) => m.querySelector(`[data-menu="${CSS.escape(hit.id)}"]`));
  if (el) { el.classList.add('hit-on'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}

$('messages').onclick = async (e) => {
  const caret = e.target.closest('[data-menu]');
  if (caret) {
    e.stopPropagation();
    return menuFor === caret.dataset.menu ? closeMsgMenu() : openMsgMenu(caret, caret.dataset.menu);
  }
  const id = e.target.dataset?.retry;
  if (!id) return;
  try { await api(`/api/messages/${encodeURIComponent(id)}/retry`); } catch (err) { toast(err.message); }
};

function renderComposer(chat) {
  const mine = chat.assigned_to === me.id;
  const takenByOther = chat.assigned_to && !mine;
  $('claim').textContent = mine ? 'Release' : takenByOther ? `Take over from ${chat.assignee_name}` : 'Claim';
  $('claim').className = 'claim' + (mine ? ' mine' : '');

  let block = null;
  if (!openWindow?.open) block = openWindow?.reason;
  else if (takenByOther) block = `${chat.assignee_name} is handling this chat. Take it over before replying so the customer doesn't get two answers.`;

  $('blocked').hidden = !block;
  if (block) $('blocked').textContent = block;
  $('input').disabled = !!block;
  updateSendState();

  const left = openWindow?.expiresInSec;
  $('chatSub').textContent = chat.is_group ? 'Group' : left
    ? `Reply window open · ${Math.floor(left / 3600)}h ${Math.floor(left % 3600 / 60)}m left`
    : 'Reply window closed';
}

async function openChat(id, around = null) {
  const switching = id !== open;
  open = id;
  if (switching) { closeFind(); cancelReply(); }
  closeMsgMenu();
  $('empty').hidden = true; $('panel').hidden = false;
  document.getElementById('app').classList.add('chat-open'); // phones: show the thread
  const url = `/api/chats/${encodeURIComponent(id)}${around ? `?around=${around}` : ''}`;
  const { chat, messages, window: win } = await api(url);
  openWindow = win;
  // No full number in the header either — the name is the identity.
  $('chatName').textContent = nameOf(chat);
  setAvatar($('chatAvatar'), chat.id, nameOf(chat));
  renderMessages(messages, chat.is_group);
  renderComposer(chat);
  renderChats();
  await api(`/api/chats/${encodeURIComponent(id)}/read`, {}).catch(() => {});
  loadChats();
}

async function refreshOpen() {
  if (!open) return;
  const { chat, messages, window: win } = await api(`/api/chats/${encodeURIComponent(open)}`);
  openWindow = win;
  renderMessages(messages, chat.is_group);
  renderComposer(chat);
}

$('claim').onclick = async () => {
  const chat = chats.find((c) => c.id === open);
  const mine = chat?.assigned_to === me.id;
  try {
    await api(`/api/chats/${encodeURIComponent(open)}/claim`, { release: mine, takeover: true });
    await loadChats(); await refreshOpen();
  } catch (err) { toast(err.message); }
};

// --- sending ------------------------------------------------------------
const input = $('input');
const SEND_LABEL = $('send').innerHTML;
// Blocked chats win; otherwise either text or an attachment is enough to send.
function updateSendState() {
  const blocked = $('input').disabled;
  $('attach').disabled = blocked;
  $('send').disabled = blocked || (!input.value.trim() && !pending.length);
}
input.addEventListener('input', updateSendState);
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('send').onclick = send;

async function send() {
  if (!open) return;
  if (pending.length) return sendAttachments();
  const body = input.value.trim();
  if (!body) return;
  $('send').disabled = true;
  try {
    await api(`/api/chats/${encodeURIComponent(open)}/send`, { body, replyTo: replyTo?.id || null });
    cancelReply();
    input.value = ''; input.style.height = 'auto';
    await refreshOpen(); loadChats();
  } catch (err) {
    toast(err.message); // the text stays in the box so nothing is ever lost
  } finally {
    updateSendState(); // never re-enable a composer the gate has blocked
  }
}





// <input type=date>.valueAsDate is UTC midnight, so reading local parts off it
// lands on the previous day for anyone west of UTC. Parse the value string.
const localDate = (input) => {
  const [y, m, d] = String(input.value || '').split('-').map(Number);
  return y ? new Date(y, m - 1, d) : null;
};

$('backBtn').onclick = () => {
  document.getElementById('app').classList.remove('chat-open');
  closeMsgMenu();
};

// --- message actions: reply / forward / copy ------------------------------
let replyTo = null;      // the message being answered
let menuFor = null;      // the message whose menu is open

/** The quoted message shown inside the bubble that answers it. */
function quoteOf(m) {
  if (!m.reply_to || (!m.reply_body && !m.reply_media)) return '';
  const what = realBody(m.reply_body) || PREVIEW_LABEL[m.reply_media] || '📎 Attachment';
  return `<span class="quote"><i></i><span><b>${esc(m.reply_author || 'Message')}</b><em>${esc(what.slice(0, 120))}</em></span></span>`;
}

const msgById = (id) => threadCache.find((m) => m.id === id);
const describe = (m) => realBody(m.body) || PREVIEW_LABEL[m.media_type] || '📎 Attachment';

function startReply(id) {
  const m = msgById(id);
  if (!m) return;
  replyTo = m;
  $('replyWho').textContent = m.from_me ? 'You' : (senderOf(m) || 'Customer');
  $('replyBody').textContent = describe(m).slice(0, 140);
  $('replyBar').hidden = false;
  input.focus();
}
function cancelReply() { replyTo = null; $('replyBar').hidden = true; }
$('replyCancel').onclick = cancelReply;

async function copyMessage(id) {
  const m = msgById(id);
  if (!m) return;
  const text = realBody(m.body) || describe(m);
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.', 'ok');
  } catch {
    // clipboard API needs a secure context; fall back so plain HTTP still works
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied.', 'ok'); }
    catch { toast('Could not copy on this browser.'); }
    ta.remove();
  }
}

function closeMsgMenu() {
  $('msgMenu').hidden = true;
  document.querySelectorAll('.msg-caret.open').forEach((b) => b.classList.remove('open'));
  menuFor = null;
}

/** Save an attachment without involving the operating system's drag protocol —
 *  the dependable path, and the only one Safari has. */
function downloadMessage(id) {
  const m = msgById(id);
  if (!m?.media_path) return toast('That message has no attachment.');
  const name = fileLabel(m);
  const a = document.createElement('a');
  a.href = `/media/${encodeURIComponent(m.media_path.split('/').pop())}?download=1`;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function openMsgMenu(btn, id) {
  menuFor = id;
  const menu = $('msgMenu');
  // Only offer Download where there is something to download.
  menu.querySelector('[data-act="download"]').hidden = !msgById(id)?.media_path;
  menu.hidden = false;
  btn.classList.add('open');
  // Anchor under the chevron, nudged back inside the viewport when near an edge.
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
  menu.style.top = r.bottom + h + 8 > window.innerHeight ? `${r.top - h - 4}px` : `${r.bottom + 4}px`;
}

$('msgMenu').onclick = (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const id = menuFor;
  closeMsgMenu();
  if (!act || !id) return;
  if (act === 'reply') startReply(id);
  if (act === 'select') { togglePick(id); }
  if (act === 'forward') openForward([id]);
  if (act === 'copy') copyMessage(id);
  if (act === 'download') downloadMessage(id);
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('#msgMenu') && !e.target.closest('.msg-caret')) closeMsgMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMsgMenu(); });
// A fixed-position menu must close when the thread scrolls — but only when the
// AGENT scrolls. The thread also auto-scrolls itself on every refresh and on
// each new message, which would otherwise snatch the menu away mid-click.
let autoScrolling = 0;
$('messages').addEventListener('scroll', () => { if (!autoScrolling) closeMsgMenu(); });

// --- in-chat search + jump to date ---------------------------------------
const closeFind = () => {
  $('findBar').hidden = true;
  findQuery = ''; findHits = []; findAt = -1;
  $('findInput').value = ''; $('findCount').textContent = '';
  $('findPrev').disabled = $('findNext').disabled = true;
  if (open) refreshOpen();
};

$('findBtn').onclick = () => {
  $('findBar').hidden = !$('findBar').hidden;
  if ($('findBar').hidden) return closeFind();
  $('findInput').focus();
};
$('findClose').onclick = closeFind;

let findTimer = null;
$('findInput').oninput = () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(runFind, 250); // typing shouldn't hit the server per keystroke
};
$('findInput').onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(findTimer); e.shiftKey ? stepHit(1) : stepHit(-1); }
  if (e.key === 'Escape') closeFind();
};

async function runFind() {
  const q = $('findInput').value.trim();
  if (q.length < 2) {
    findQuery = ''; findHits = []; findAt = -1;
    $('findCount').textContent = q ? 'Type 2+ characters' : '';
    $('findPrev').disabled = $('findNext').disabled = true;
    return refreshOpen();
  }
  try {
    const { hits } = await api(`/api/chats/${encodeURIComponent(open)}/search?q=${encodeURIComponent(q)}`);
    findQuery = q;
    findHits = hits;            // newest first, matching the up/down arrows
    findAt = hits.length ? 0 : -1;
    $('findCount').textContent = hits.length ? `1 of ${hits.length}` : 'No matches';
    $('findPrev').disabled = $('findNext').disabled = hits.length < 2;
    if (hits.length) await gotoHit(0); else await refreshOpen();
  } catch (err) { $('findCount').textContent = err.message; }
}

/** Load whatever window contains the hit, then highlight it. */
async function gotoHit(i) {
  const hit = findHits[i];
  if (!hit) return;
  findAt = i;
  $('findCount').textContent = `${i + 1} of ${findHits.length}`;
  const loaded = threadCache.some((m) => m.id === hit.id);
  if (!loaded) await openChat(open, hit.ts); // the hit is outside the loaded window
  else renderMessages(threadCache, chats.find((c) => c.id === open)?.is_group);
  paintCurrentHit();
}

const stepHit = (d) => { if (findHits.length) gotoHit((findAt + d + findHits.length) % findHits.length); };
$('findPrev').onclick = () => stepHit(1);  // older
$('findNext').onclick = () => stepHit(-1); // newer

$('jumpBtn').onclick = async () => {
  const d = localDate($('jumpDate'));
  if (!d) return ($('findCount').textContent = 'Pick a date');
  const ts = Math.floor(d.getTime() / 1000);
  await openChat(open, ts);
  // Land on the first message of that day, or the nearest one after it.
  const target = threadCache.find((m) => m.ts >= ts);
  $('findCount').textContent = target ? '' : 'Nothing on or after that date';
  if (!target) return;
  const el = [...document.querySelectorAll('#messages .msg')]
    .find((m) => m.querySelector(`[data-menu="${CSS.escape(target.id)}"]`));
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el?.previousElementSibling?.classList.add('jumped');
};

// --- list filters --------------------------------------------------------
document.querySelectorAll('.cats .chip').forEach((c) => {
  c.onclick = () => {
    document.querySelectorAll('.cats .chip').forEach((x) => x.classList.toggle('on', x === c));
    category = c.dataset.cat;
    renderChats();
  };
});

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const asSecs = (d) => Math.floor(d.getTime() / 1000);

function applyDateFilter() {
  const from = localDate($('cFrom')), to = localDate($('cTo'));
  dateFrom = from ? asSecs(from) : null;
  dateTo = to ? asSecs(new Date(to.getTime() + 86400e3)) : null; // the end date is inclusive
  $('dateBtn').classList.toggle('on', dateFrom !== null || dateTo !== null);
  renderChats();
}

$('dateBtn').onclick = () => { $('datePanel').hidden = !$('datePanel').hidden; };
$('cFrom').onchange = applyDateFilter;
$('cTo').onchange = applyDateFilter;
$('dateClear').onclick = () => {
  $('cFrom').value = ''; $('cTo').value = '';
  document.querySelectorAll('.date-quick .chip').forEach((x) => x.classList.remove('on'));
  applyDateFilter();
};
document.querySelectorAll('.date-quick .chip').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.date-quick .chip').forEach((x) => x.classList.toggle('on', x === b));
    const days = Number(b.dataset.days);
    const from = startOfToday(); from.setDate(from.getDate() - days);
    const ymd = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    $('cFrom').value = ymd(from);
    $('cTo').value = ymd(startOfToday());
    applyDateFilter();
  };
});

// --- forward -------------------------------------------------------------
let forwarding = null; // the messages being forwarded, in the order picked

function openForward(ids) {
  const msgs = ids.map(msgById).filter(Boolean);
  if (!msgs.length) return;
  forwarding = msgs;
  $('fwdErr').textContent = '';
  $('fwdSearch').value = '';
  if (msgs.length === 1) {
    const [msg] = msgs;
    const what = msg.media_path ? `${PREVIEW_LABEL[msg.media_type] || '📎 Attachment'}${realBody(msg.body) ? ' · ' : ''}` : '';
    $('fwdPreview').textContent = what + realBody(msg.body).slice(0, 160);
  } else {
    const files = msgs.filter((m) => m.media_path).length;
    $('fwdPreview').textContent = `${msgs.length} messages` + (files ? ` · ${files} attachment${files === 1 ? '' : 's'}` : '');
  }
  renderForwardList();
  $('fwdModal').hidden = false;
  $('fwdSearch').focus();
}

function renderForwardList() {
  const q = $('fwdSearch').value.trim().toLowerCase();
  const rows = chats
    .filter((c) => c.id !== forwarding?.[0]?.chat_id)
    .filter((c) => !q || nameOf(c).toLowerCase().includes(q) || c.id.includes(q))
    .slice(0, 40);
  $('fwdList').innerHTML = rows.length ? rows.map((c) => `
    <button class="fwd-row" data-to="${esc(c.id)}">
      ${avatar(c.id, nameOf(c))}
      <span><span class="n">${esc(nameOf(c))}</span>${c.is_group ? ' <span class="s">· group</span>' : ''}
        ${c.assignee_name ? `<span class="s"> · ${esc(c.assignee_name)}</span>` : ''}</span>
    </button>`).join('') : '<div class="hint">No conversations match.</div>';
}

$('fwdSearch').oninput = renderForwardList;
// One request per message, in the order they were picked. Same reasoning as
// attachments: each one meets the gate on its own, and the server never grows
// a route that fans several messages out at once.
$('fwdList').onclick = async (e) => {
  const row = e.target.closest('[data-to]');
  if (!row || !forwarding?.length) return;
  $('fwdErr').textContent = '';
  const msgs = forwarding;
  let chatName = '';
  const failed = [];

  for (const m of msgs) {
    try {
      const { chat } = await api(`/api/messages/${encodeURIComponent(m.id)}/forward`, { to: row.dataset.to });
      chatName = chat.name;
    } catch (err) { failed.push(err.message); }
  }

  const sent = msgs.length - failed.length;
  if (!sent) { $('fwdErr').textContent = failed[0] || 'Nothing could be forwarded.'; return; }
  $('fwdModal').hidden = true;
  forwarding = null;
  clearPicked();
  toast(failed.length
    ? `Forwarded ${sent} of ${msgs.length} to ${chatName}. ${failed[0]}`
    : `Forwarded ${sent > 1 ? `${sent} messages` : ''} to ${chatName}.`.replace('  ', ' '), failed.length ? '' : 'ok');
  loadChats();
};
const closeFwd = () => { $('fwdModal').hidden = true; forwarding = null; };
$('fwdClose').onclick = closeFwd;
$('fwdModal').onclick = (e) => { if (e.target.id === 'fwdModal') closeFwd(); };

// --- voice notes ---------------------------------------------------------
// One <audio> for the whole app, deliberately outside the DOM: the thread is
// re-rendered wholesale every refresh, and an element inside it would have its
// playback cut off mid-word.
const player = new Audio();
const peaksCache = new Map(); // src -> { peaks, duration } | null when undecodable
const BARS = 42;
let playingSrc = null;

const mmss = (s) => Number.isFinite(s)
  ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00';

/** Fetch once, then derive everything from those bytes.
 *
 *  The blob is not an optimisation. WhatsApp's opus files make Chrome's media
 *  element fail with "Format error" when it pulls them over HTTP range requests,
 *  while the very same bytes play fine from a blob URL — so the file is fetched
 *  whole and handed to the player that way.
 *
 *  Peaks are read off the decoded audio: WhatsApp's waveform means something,
 *  and a decorative random one would be a lie about the recording. */
async function loadVoice(src) {
  if (peaksCache.has(src)) return peaksCache.get(src);
  const entry = { peaks: null, duration: NaN, url: src };
  peaksCache.set(src, entry); // claim the slot so a re-render doesn't refetch
  try {
    const bytes = await (await fetch(src)).arrayBuffer();
    // Blob first: decodeAudioData detaches the buffer it is handed.
    entry.url = URL.createObjectURL(new Blob([bytes], { type: 'audio/ogg' }));
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await ctx.decodeAudioData(bytes);
    ctx.close();
    const data = buf.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / BARS));
    const peaks = [];
    for (let i = 0; i < BARS; i++) {
      let peak = 0;
      for (let j = 0; j < step; j += 8) peak = Math.max(peak, Math.abs(data[i * step + j] || 0));
      peaks.push(peak);
    }
    const max = Math.max(...peaks, 0.01);
    entry.peaks = peaks.map((p) => Math.max(0.14, p / max));
    entry.duration = buf.duration;
  } catch {
    // Opus decoding isn't universal (Safari). A flat bar still plays.
  }
  return entry;
}

function paintVoice(el) {
  const src = el.dataset.src;
  const info = peaksCache.get(src);
  const wave = el.querySelector('.voice-wave');
  // Decoding finishes after the first paint, so the placeholder bars have to be
  // replaced when the real ones arrive — not left flat until the next refresh.
  const want = info?.peaks ? 'peaks' : 'flat';
  if (wave.dataset.painted !== want) {
    wave.dataset.painted = want;
    wave.innerHTML = (info?.peaks || Array.from({ length: BARS }, () => 0.34))
      .map((p) => `<i style="height:${Math.round(p * 100)}%"></i>`).join('');
  }
  const live = playingSrc === src;
  const total = Number.isFinite(info?.duration) ? info.duration
    : (live && Number.isFinite(player.duration) ? player.duration : NaN);
  const at = live ? player.currentTime : 0;
  const frac = live && total ? at / total : 0;
  const bars = wave.children;
  for (let i = 0; i < bars.length; i++) bars[i].classList.toggle('on', i / bars.length <= frac);
  el.querySelector('.voice-time').textContent = live ? mmss(at) : mmss(total);
  el.classList.toggle('playing', live && !player.paused);
}

function paintAllVoice() { document.querySelectorAll('.voice').forEach(paintVoice); }

player.addEventListener('timeupdate', paintAllVoice);
player.addEventListener('ended', () => { playingSrc = null; paintAllVoice(); });
player.addEventListener('pause', paintAllVoice);
player.addEventListener('play', paintAllVoice);

/** Wire up whatever voice notes are on screen after a render. */
function initVoice() {
  document.querySelectorAll('.voice').forEach(async (el) => {
    paintVoice(el);
    if (!peaksCache.has(el.dataset.src)) { await loadVoice(el.dataset.src); paintVoice(el); }
  });
}

$('messages').addEventListener('click', async (e) => {
  const el = e.target.closest('.voice');
  if (!el) return;
  const src = el.dataset.src;

  if (e.target.closest('.voice-wave')) { // seek
    const wave = el.querySelector('.voice-wave');
    const r = wave.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const total = peaksCache.get(src)?.duration || player.duration;
    if (playingSrc === src && Number.isFinite(total)) { player.currentTime = frac * total; paintAllVoice(); }
    return;
  }
  if (!e.target.closest('.voice-play')) return;

  if (playingSrc === src && !player.paused) { player.pause(); return; }
  if (playingSrc !== src) {
    const info = await loadVoice(src); // already cached in the normal case
    player.src = info.url;
    playingSrc = src;
  }
  player.play().catch(() => toast('This audio cannot be played in this browser.'));
});

// --- attachments --------------------------------------------------------
let pending = [];   // File[] — everything staged for the next send
const MAX_MB = 16;
// Each file becomes its own outbound message, and the pacer puts seconds
// between them. A large batch would eat the hourly cap for the chat and take
// minutes to drain, so stop well before that becomes a surprise.
const MAX_FILES = 10;
const prettySize = (n) => n < 1024 * 1024
  ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;
const DOC_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>';

function clearAttachment() {
  pending.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
  pending = [];
  $('file').value = '';
  renderAttachments();
}

function renderAttachments() {
  $('attachment').hidden = pending.length === 0;
  $('attachList').innerHTML = pending.map((f, i) => `
    <span class="attach-chip">
      ${f.previewUrl
        ? `<img class="attach-thumb" src="${f.previewUrl}" alt="">`
        : `<span class="attach-icon">${DOC_ICON}</span>`}
      <span class="attach-text"><span class="n">${esc(f.name)}</span><span class="attach-size">${prettySize(f.size)}</span></span>
      <button class="icon-btn" data-drop="${i}" title="Remove" aria-label="Remove ${esc(f.name)}">&times;</button>
    </span>`).join('');
  updateSendState();
}

/** Stage files from the picker, a paste, or a drop — all the same thing. */
function addAttachments(list) {
  const files = [...(list || [])];
  if (!files.length) return;
  const room = MAX_FILES - pending.length;
  if (room <= 0) return toast(`That is already ${MAX_FILES} files — send these first.`);

  const tooBig = files.filter((f) => f.size > MAX_MB * 1024 * 1024);
  const ok = files.filter((f) => f.size <= MAX_MB * 1024 * 1024).slice(0, room);
  tooBig.forEach((f) => toast(`"${f.name}" is ${prettySize(f.size)} — the limit is ${MAX_MB} MB.`));
  if (files.length - tooBig.length > room) toast(`Only the first ${room} were added — ${MAX_FILES} files at a time.`);

  for (const f of ok) {
    // Held on the File object so the chip can be re-rendered without leaking a
    // new blob URL each time.
    if (f.type.startsWith('image/')) f.previewUrl = URL.createObjectURL(f);
    pending.push(f);
  }
  $('file').value = '';   // so picking the same file again still fires onchange
  renderAttachments();
}

$('attach').onclick = () => $('file').click();
$('attachClear').onclick = clearAttachment;
$('file').onchange = (e) => addAttachments(e.target.files);
$('attachList').onclick = (e) => {
  const i = e.target.closest('[data-drop]')?.dataset.drop;
  if (i === undefined) return;
  const [gone] = pending.splice(Number(i), 1);
  if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
  renderAttachments();
};

// Paste a screenshot straight into the composer.
input.addEventListener('paste', (e) => {
  if (e.clipboardData?.files?.length) { e.preventDefault(); addAttachments(e.clipboardData.files); }
});

// --- drag files in from the desktop --------------------------------------
// The whole thread is the target, not a thin strip: dropping a file "on the
// conversation" is what people expect it to mean.
const thread = document.querySelector('.thread');
let dragDepth = 0;
const draggingFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

thread.addEventListener('dragenter', (e) => {
  if (!draggingFiles(e) || $('input').disabled || !open) return;
  e.preventDefault();
  if (++dragDepth === 1) thread.classList.add('dropping');
});
thread.addEventListener('dragover', (e) => {
  if (!draggingFiles(e) || $('input').disabled || !open) return;
  e.preventDefault();                       // without this the browser navigates
  e.dataTransfer.dropEffect = 'copy';
});
thread.addEventListener('dragleave', () => {
  if (dragDepth && --dragDepth === 0) thread.classList.remove('dropping');
});
thread.addEventListener('drop', (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  thread.classList.remove('dropping');
  if ($('input').disabled || !open) return toast('Open a conversation you can reply to first.');
  addAttachments(e.dataTransfer.files);
});

const readAsBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(new Error('Could not read that file.'));
  r.readAsDataURL(file);
});

/** Send each staged file as its own message, one at a time.
 *
 *  Deliberately a loop over the single-file endpoint rather than a bulk route:
 *  every file then passes the outbound gate on its own, so the hourly cap and
 *  the duplicate-file guard still mean what they say, and the server keeps no
 *  path that sends many things at once. Whatever fails stays attached.
 */
async function sendAttachments() {
  const files = pending.slice();
  const caption = input.value.trim();
  const quoted = replyTo?.id || null;
  $('send').disabled = true;
  const done = [];
  const failed = [];

  for (const [i, file] of files.entries()) {
    $('send').textContent = files.length > 1 ? `Sending ${i + 1} of ${files.length}…` : 'Sending…';
    try {
      await api(`/api/chats/${encodeURIComponent(open)}/media`, {
        filename: file.name,
        // The caption and the reply belong to the batch, not to every file —
        // repeating them would read as spam at the other end.
        caption: i === 0 ? caption : '',
        data: await readAsBase64(file),
        replyTo: i === 0 ? quoted : null,
      });
      done.push(file);
    } catch (err) {
      failed.push(`${file.name} — ${err.message}`);
    }
  }

  // Keep only what did not go, so a retry does not re-send anything.
  done.forEach((f) => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
  pending = pending.filter((f) => !done.includes(f));
  $('file').value = '';
  renderAttachments();

  if (done.length) {
    cancelReply();
    input.value = ''; input.style.height = 'auto';
    if (files.length > 1) toast(`Sent ${done.length} of ${files.length}.`, failed.length ? '' : 'ok');
  }
  if (failed.length) toast(failed.length === 1 ? failed[0] : `${failed.length} could not be sent — ${failed[0]}`);

  $('send').innerHTML = SEND_LABEL;
  updateSendState();
  await refreshOpen(); loadChats();
}

// --- live updates -------------------------------------------------------
let stream = null;
function connect() {
  const es = stream = new EventSource('/api/stream');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'status') {
      const el = $('conn');
      el.textContent = stateLabel(ev.status);
      el.className = 'conn ' + (ev.status === 'connected' ? 'ok' : 'bad');
    }
    if (ev.type === 'chats') loadChats();
    if (ev.type === 'message' && ev.message?.chat_id === open) refreshOpen();
    if (ev.type === 'message' && ev.message?.chat_id !== open) loadChats();
  };
  // EventSource cannot see a 401 — it just retries forever, so a dead session is
  // indistinguishable from a dead server unless we go and ask.
  let probing = false;
  es.onerror = async () => {
    $('conn').textContent = 'reconnecting…';
    $('conn').className = 'conn bad';
    if (probing || expired) return;
    probing = true;
    try { await api('/api/me'); } catch { /* sessionExpired() already fired on 401 */ }
    finally { probing = false; }
  };
}




// Connection wording lives here and nowhere else. Nothing internal — no service
// names, no process names — ever reaches the screen.
const STATE_LABEL = {
  connected: 'WhatsApp connected',
  logged_out: 'WhatsApp not linked',
  disconnected: 'WhatsApp offline',
  unreachable: 'WhatsApp offline',
  starting: 'Connecting…',
};
const stateLabel = (s) => STATE_LABEL[s] || 'Connecting…';

// --- profile menu --------------------------------------------------------
const closeMenu = () => { $('profileMenu').hidden = true; $('profileBtn').setAttribute('aria-expanded', 'false'); };
$('profileBtn').onclick = (e) => {
  e.stopPropagation();
  const open = $('profileMenu').hidden;
  $('profileMenu').hidden = !open;
  $('profileBtn').setAttribute('aria-expanded', String(open));
};
document.addEventListener('click', (e) => { if (!e.target.closest('.profile')) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });


// Row actions are icons; the label lives in title + aria-label so the meaning is
// never carried by the glyph alone.
const ICON = {
  key: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 2-2 2m-7.6 7.6a5 5 0 1 1-7.1 7.1 5 5 0 0 1 7.1-7.1Zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3"/></svg>',
  remove: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M17 11h6"/></svg>',
  restore: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M20 8v6M23 11h-6"/></svg>',
  signout: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
  shared: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
};

// --- admin: team management ---------------------------------------------
// Reset only. An agent who forgets their password asks the admin — there is
// deliberately no self-service path.
async function loadTeam() {
  const { users, seats } = await api('/api/admin/users');
  const full = seats.used >= seats.max;
  $('seatCount').textContent = `${seats.used} of ${seats.max} seats used`;
  $('seatBar').className = 'seat-bar' + (full ? ' full' : '');
  $('seatBar').firstElementChild.style.width = `${Math.round((seats.used / seats.max) * 100)}%`;
  $('addUser').querySelector('button[type=submit]').disabled = full;

  $('teamList').innerHTML = users.map((u) => `
    <div class="member ${u.active ? '' : 'off'}" data-id="${u.id}">
      <input class="pick" type="checkbox" data-pick="${u.id}" aria-label="Select ${esc(u.name)}"
        ${u.active && u.sessions ? '' : 'disabled'}>
      ${avatar(String(u.id) + u.username, u.name)}
      <div>
        <div class="n">${esc(u.name)}${u.is_admin ? '<span class="tag">admin</span>' : ''}${u.id === me.id ? '<span class="tag">you</span>' : ''}${u.active ? '' : '<span class="tag muted-tag">removed</span>'}</div>
        <div class="u">@${esc(u.username)}${u.active && u.sessions ? ` · signed in` : ''}</div>
      </div>
      <div class="member-btns">
        ${u.active ? `<button class="icon-act" data-reset="${u.id}" title="Reset password" aria-label="Reset ${esc(u.name)}'s password">${ICON.key}</button>` : ''}
        ${u.id === me.id ? '' : u.active
          ? `<button class="icon-act danger" data-active="0" data-user="${u.id}" title="Remove from team" aria-label="Remove ${esc(u.name)} from the team">${ICON.remove}</button>`
          : `<button class="icon-act ok" data-active="1" data-user="${u.id}" title="Restore to team" aria-label="Restore ${esc(u.name)} to the team">${ICON.restore}</button>`}
      </div>
    </div>`).join('');
  updatePicks();
}

function updatePicks() {
  const n = document.querySelectorAll('[data-pick]:checked').length;
  $('forceLogout').disabled = !n;
  $('forceLogout').innerHTML = `${ICON.signout}<span>${n ? `Force sign-out (${n})` : 'Force sign-out'}</span>`;
}

$('teamList').onclick = async (e) => {
  const row = e.target.closest('.member');
  if (!row) return;
  if (e.target.dataset.pick) return updatePicks();
  $('teamErr').textContent = '';

  if (e.target.dataset.active) {
    const on = e.target.dataset.active === '1';
    try {
      await api(`/api/admin/users/${e.target.dataset.user}/active`, { active: on });
      await loadTeam();
      toast(on ? 'Member restored.' : 'Member removed — their sessions were ended.', 'ok');
    } catch (err) { $('teamErr').textContent = err.message; }
    return;
  }

  if (e.target.dataset.reset) {
    if (row.querySelector('.reset-row')) return;
    row.insertAdjacentHTML('beforeend', `
      <div class="reset-row">
        <input type="text" placeholder="New password (min 8 characters)" minlength="8" autocomplete="off">
        <button class="btn-sm primary" data-save="${row.dataset.id}">Save</button>
        <button class="btn-sm" data-cancel="1">Cancel</button>
      </div>`);
    row.querySelector('input').focus();
  }
  if (e.target.dataset.cancel) row.querySelector('.reset-row').remove();
  if (e.target.dataset.save) {
    const pw = row.querySelector('.reset-row input').value;
    try {
      await api(`/api/admin/users/${e.target.dataset.save}/password`, { password: pw });
      row.querySelector('.reset-row').remove();
      toast('Password updated — they have been signed out of any open sessions.', 'ok');
    } catch (err) { $('teamErr').textContent = err.message; }
  }
};

// A username is a sign-in name, not a person's name — but "Khalid Sheikh" is
// what anyone types into a field labelled Username. Rather than rejecting it,
// shape it as they type: spaces and anything else outside the allowed set
// become dots, so they watch it turn into khalid.sheikh and never meet the
// validation error at all.
const toUsername = (v) => String(v).toLowerCase().replace(/[^a-z0-9._-]+/g, '.').replace(/\.{2,}/g, '.').slice(0, 32);
const trimSeps = (v) => v.replace(/^[._-]+|[._-]+$/g, '');

/** Put a validation message under the input it is about. A message at the foot
 *  of the form tells you something is wrong; it does not tell you where. */
function clearFieldErrors(form) {
  form.querySelectorAll('.field.bad').forEach((l) => l.classList.remove('bad'));
  form.querySelectorAll('.field-err').forEach((n) => n.remove());
}

function showFormError(form, err, fallbackEl) {
  clearFieldErrors(form);
  const input = err.field && form.elements[err.field];
  if (!input) { fallbackEl.textContent = err.message; return; }
  fallbackEl.textContent = '';
  const field = input.closest('.field');
  field.classList.add('bad');
  const note = document.createElement('span');
  note.className = 'field-err';
  note.textContent = err.message;
  field.appendChild(note);
  input.focus();
  input.select();
}

const usernameInput = $('addUser').elements.username;
// Any edit clears the complaint, so it never lingers over a corrected field.
$('addUser').addEventListener('input', () => clearFieldErrors($('addUser')));
usernameInput.oninput = () => {
  const start = usernameInput.selectionStart;
  const before = usernameInput.value;
  const after = toUsername(before);
  if (after === before) return;
  usernameInput.value = after;
  // Keep the caret where the typing was, not thrown to the end.
  usernameInput.setSelectionRange(start, start);
};

$('addUser').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('teamErr').textContent = '';
  try {
    await api('/api/admin/users', {
      username: trimSeps(toUsername(f.get('username'))), name: f.get('name'),
      password: f.get('password'), is_admin: f.get('is_admin') === 'on',
    });
    e.target.reset();
    clearFieldErrors(e.target);
    await loadTeam();
    toast('User created.', 'ok');
  } catch (err) { showFormError(e.target, err, $('teamErr')); }
};


$('forceLogout').onclick = async () => {
  const ids = [...document.querySelectorAll('[data-pick]:checked')].map((c) => Number(c.dataset.pick));
  $('teamErr').textContent = '';
  try {
    const { signedOut } = await api('/api/admin/logout-users', { ids });
    await loadTeam();
    toast(`Signed out: ${signedOut.join(', ')}`, 'ok');
  } catch (err) { $('teamErr').textContent = err.message; }
};

$('resetAll').innerHTML = `${ICON.shared}<span>Set one shared password…</span>`;
$('resetAll').onclick = () => { $('resetAllForm').hidden = false; $('resetAllForm').querySelector('input').focus(); };
$('resetAllCancel').onclick = () => { $('resetAllForm').hidden = true; $('resetAllForm').reset(); };
$('resetAllForm').onsubmit = async (e) => {
  e.preventDefault();
  $('teamErr').textContent = '';
  try {
    const password = new FormData(e.target).get('password');
    const { count } = await api('/api/admin/reset-all-passwords', { password });
    $('resetAllForm').hidden = true; e.target.reset();
    // Admins keep their own password, so the person who just did this is still
    // signed in — reload the list rather than throwing them back to the login.
    await loadTeam();
    toast(count
      ? `${count} agent${count === 1 ? '' : 's'} now share this password and have been signed out.`
      : 'No agent accounts to change — admins keep their own passwords.', 'ok');
  } catch (err) { $('teamErr').textContent = err.message; }
};

const closeTeam = () => { $('teamModal').hidden = true; $('teamErr').textContent = ''; };
$('team').onclick = async () => {
  closeMenu();
  $('teamModal').hidden = false;
  try { await loadTeam(); } catch (err) { $('teamErr').textContent = err.message; }
};
$('teamClose').onclick = closeTeam;
$('teamModal').onclick = (e) => { if (e.target.id === 'teamModal') closeTeam(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('teamModal').hidden) closeTeam(); });


// --- admin: reports ------------------------------------------------------
// Categorical slots, fixed order, never cycled: a 7th agent folds into "Other"
// rather than inventing a hue. Validated for CVD separation in both themes.
const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];
const SERIES_DARK  = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'];
const OTHER = '#8696a0';
const series = () => (matchMedia('(prefers-color-scheme: dark)').matches ? SERIES_DARK : SERIES_LIGHT);

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const secs = (d) => Math.floor(d.getTime() / 1000);

function rangeFor(kind) {
  const now = new Date(), today = startOfDay(now);
  if (kind === 'week') {
    const from = startOfDay(now);
    from.setDate(from.getDate() - ((from.getDay() + 6) % 7)); // weeks start Monday
    return [from, new Date(today.getTime() + 86400e3)];
  }
  if (kind === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1), new Date(today.getTime() + 86400e3)];
  if (kind === 'last') return [new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 1)];
  return null;
}

function donut(rows, total) {
  const svg = $('donut');
  const C = 2 * Math.PI * 54;
  const cols = series();
  if (!total) {
    svg.innerHTML = `<circle cx="70" cy="70" r="54" fill="none" stroke="var(--line)" stroke-width="18"></circle>`;
    svg.querySelector('desc')?.remove();
    return;
  }
  let offset = 0;
  const arcs = rows.map((r, i) => {
    const len = (r.messages / total) * C;
    // 2px of surface between segments so neighbours never bleed together
    const seg = `<circle cx="70" cy="70" r="54" fill="none" stroke="${r.color}" stroke-width="18"
      stroke-dasharray="${Math.max(0, len - 2).toFixed(2)} ${(C - len + 2).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}"></circle>`;
    offset += len;
    return seg;
  }).join('');
  svg.innerHTML = `<desc>Share of replies by agent</desc><g transform="rotate(-90 70 70)">${arcs}</g>
    <text x="70" y="66" text-anchor="middle" fill="var(--text)" font-size="19" font-weight="650">${total}</text>
    <text x="70" y="83" text-anchor="middle" fill="var(--muted)" font-size="9.5">replies</text>`;
}

async function loadReport(from, to) {
  $('reportErr').textContent = '';
  const { days, agents } = await api(`/api/admin/report?from=${secs(from)}&to=${secs(to)}`);

  const totalMsgs = agents.reduce((n, a) => n + a.messages, 0);
  $('statMessages').textContent = totalMsgs;
  $('statCustomers').textContent = new Set(days.length ? days.map((d) => d.day) : []).size
    ? days.reduce((n, d) => n + d.customers, 0) : 0;
  $('statDays').textContent = days.length;

  $('matrixBody').innerHTML = days.length ? days.map((d) => `
    <tr><td>${new Date(d.day + 'T00:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</td>
      <td class="num">${d.customers}</td><td class="num">${d.messages}</td><td class="num">${d.agents}</td></tr>`).join('')
    : '<tr class="empty-row"><td colspan="4">No replies were sent in this period.</td></tr>';

  // Top 6 by volume; the rest become one "Other" slice.
  const cols = series();
  const top = agents.slice(0, 6).map((a, i) => ({ ...a, color: cols[i] }));
  const rest = agents.slice(6);
  if (rest.length) {
    top.push({ id: 'other', name: `${rest.length} others`, color: OTHER,
      messages: rest.reduce((n, a) => n + a.messages, 0),
      customers: rest.reduce((n, a) => n + a.customers, 0) });
  }
  donut(top, totalMsgs);
  $('legend').innerHTML = top.length ? top.map((a) => `
    <div class="legend-row"><i style="background:${a.color}"></i>
      <b>${esc(a.name)}${a.active === 0 ? ' (removed)' : ''}</b>
      <span>${a.messages} · ${totalMsgs ? Math.round((a.messages / totalMsgs) * 100) : 0}% · ${a.customers} customers</span>
    </div>`).join('') : '<div class="hint">Nobody replied in this period.</div>';
}

let reportRange = 'week';
async function runReport() {
  let r = rangeFor(reportRange);
  if (!r) {
    const from = $('fromDate').valueAsDate, to = $('toDate').valueAsDate;
    if (!from || !to) return ($('reportErr').textContent = 'Pick both dates.');
    if (to < from) return ($('reportErr').textContent = 'The end date is before the start date.');
    if ((to - from) / 86400e3 > 62) return ($('reportErr').textContent = 'Pick a period of two months or less.');
    r = [from, new Date(to.getTime() + 86400e3)]; // the end date is inclusive
  }
  try { await loadReport(r[0], r[1]); } catch (err) { $('reportErr').textContent = err.message; }
}

$('reports').onclick = async () => {
  closeMenu();
  $('reportModal').hidden = false;
  await runReport();
};
$('reportClose').onclick = () => { $('reportModal').hidden = true; };
$('reportModal').onclick = (e) => { if (e.target.id === 'reportModal') $('reportModal').hidden = true; };
document.querySelectorAll('.filters .chip').forEach((c) => {
  c.onclick = () => {
    document.querySelectorAll('.filters .chip').forEach((x) => x.classList.toggle('on', x === c));
    reportRange = c.dataset.range;
    $('customRange').hidden = reportRange !== 'custom';
    if (reportRange !== 'custom') runReport();
  };
});
$('applyRange').onclick = runReport;

// --- admin: storage -------------------------------------------------------
// Nothing deletes attachments, so this is the number that decides when the
// volume needs attention. Shown as a share of the disk the data volume sits
// on, with the two things actually consuming it broken out.
const gb = (n) => `${(n / 1073741824).toFixed(n < 1073741824 ? 2 : 1)} GB`;
const mb = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(0)} MB`);

$('storage').onclick = async () => {
  closeMenu();
  $('storageModal').hidden = false;
  $('storageBody').innerHTML = '<p class="hint">Reading…</p>';
  try {
    const d = await api('/api/admin/storage');
    const pct = d.total ? Math.round((d.used / d.total) * 100) : 0;
    const level = pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : '';
    $('storageBody').innerHTML = `
      <div class="store-head">
        <span class="store-pct">${pct}%</span>
        <span class="hint">${gb(d.used)} of ${gb(d.total)} used · ${gb(d.free)} free</span>
      </div>
      <div class="store-bar ${level}"><i style="width:${Math.min(100, pct)}%"></i></div>
      <div class="store-rows">
        <div class="store-row"><span>Attachments</span><span>${mb(d.mediaBytes)} · ${d.mediaFiles.toLocaleString()} files</span></div>
        <div class="store-row"><span>Conversation database</span><span>${mb(d.dbBytes)}</span></div>
        <div class="store-row"><span>Everything else on the disk</span><span>${gb(Math.max(0, d.used - d.mediaBytes - d.dbBytes))}</span></div>
      </div>
      ${level ? `<p class="hint warn-hint" style="margin-top:14px">${pct >= 90
        ? 'Almost full. Attachments are never deleted — free space or add a retention rule now.'
        : 'Filling up. Attachments are never deleted, so this only grows.'}</p>` : ''}`;
  } catch (err) { $('storageBody').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
};
const closeStorage = () => { $('storageModal').hidden = true; };
$('storageClose').onclick = closeStorage;
$('storageModal').onclick = (e) => { if (e.target.id === 'storageModal') closeStorage(); };

// --- admin: WhatsApp device linking --------------------------------------
let waTimer = null;
let waWaiting = false;
let waWasLinked = null;   // null until the first poll, so opening an already-linked
                          // modal does not announce a connection that happened hours ago
// Poll fast while a QR is being prepared, slowly once it is on screen.
function waPoll(ms) { clearInterval(waTimer); waTimer = setInterval(loadWa, ms); }
async function loadWa() {
  try {
    const s = await api('/api/admin/whatsapp');
    const linked = s.state === 'connected';
    $('waDot').className = 'wa-dot ' + (linked ? 'ok' : s.state === 'logged_out' ? 'bad' : '');
    $('waStatus').textContent = linked ? 'Linked and connected'
      : waWaiting && !s.qr ? 'Preparing the QR code…'
      : s.state === 'logged_out' ? 'No phone linked'
      : 'Not connected right now';
    $('waNumber').textContent = linked && s.number
      ? `+${s.number}${s.contactSync === 'on' && s.contacts ? ` · ${s.contacts} contacts synced` : ''}` : '';

    // Announce the moment it lands, and only that moment.
    if (linked && waWasLinked === false) toast(`WhatsApp connected as +${s.number}`, 'ok');
    waWasLinked = linked;

    // Asked once per linked phone. Unlinking resets it, so a new phone is a new
    // decision rather than an inherited yes.
    const ask = linked && s.contactSync === 'pending';
    $('waSync').hidden = !ask;
    if (ask) $('waSyncNum').textContent = `+${s.number}`;
    $('waQrWrap').hidden = !s.qr;
    if (s.qr) { $('waQr').src = s.qr; waWaiting = false; waPoll(3000); }
    // Linking needs the newer connection service. Say what to do about it in
    // plain words instead of showing a state that contradicts the header.
    $('waNote').hidden = s.controls !== false;
    $('waLinkBtn').hidden = s.controls === false || linked || !!s.qr || waWaiting;
    $('waUnlinkBtn').hidden = s.controls === false || !linked;
  } catch (err) { $('waErr').textContent = err.message; }
}

$('waLink').onclick = () => {
  closeMenu();
  $('waModal').hidden = false;
  $('waErr').textContent = '';
  $('waConfirm').hidden = true;
  $('waSync').hidden = true;
  loadWa();
  waPoll(3000); // the QR rotates every ~20s
};
// --- connection history ---------------------------------------------------
const WA_EVENT = {
  linked:           { cls: 'on',  text: (d) => `Linked to +${d}` },
  link_requested:   { cls: '',    text: () => 'Link requested — QR shown' },
  unlinked:         { cls: 'off', text: (d) => (d ? `Unlinked +${d}` : 'Phone unlinked') },
  contacts_synced:  { cls: 'on',  text: () => 'Contacts imported' },
  contacts_skipped: { cls: '',    text: () => 'Contacts not imported' },
};

async function loadWaLog() {
  try {
    const { events } = await api('/api/admin/whatsapp/history');
    $('waLog').innerHTML = events.length ? events.map((e) => {
      const spec = WA_EVENT[e.kind] || { cls: '', text: () => e.kind };
      return `<div class="wa-ev ${spec.cls}"><i></i><div>
        <div>${esc(spec.text(e.detail))}</div>
        <div class="t">${esc(when(e.ts))}${e.by_name ? ` · ${esc(e.by_name)}` : ''}</div>
      </div></div>`;
    }).join('') : '<div class="none">Nothing recorded yet.</div>';
  } catch (err) { $('waLog').innerHTML = `<div class="none">${esc(err.message)}</div>`; }
}

$('waHistory').onclick = async () => {
  const show = $('waLog').hidden;
  $('waLog').hidden = !show;
  $('waHistory').setAttribute('aria-expanded', String(show));
  if (show) await loadWaLog();
};

const closeWa = () => {
  $('waModal').hidden = true; clearInterval(waTimer); waTimer = null;
  waWaiting = false; waWasLinked = null;
  $('waLog').hidden = true; $('waHistory').setAttribute('aria-expanded', 'false');
};

// Either answer is the end of the job: the phone is linked and the contact
// decision is made, so the panel closes itself rather than leaving the admin
// looking at a dialog with nothing left to do. An error keeps it open — that
// is the one case where there is still something to read.
$('waSyncYes').onclick = async () => {
  $('waErr').textContent = '';
  $('waSync').hidden = true;
  toast('Importing contacts…');
  try {
    await api('/api/admin/whatsapp/contacts/sync', {});
    toast('Contacts imported. Names appear as the sync finishes.', 'ok');
    closeWa();
  } catch (err) { $('waErr').textContent = err.message; await loadWa(); }
};

$('waSyncNo').onclick = async () => {
  $('waErr').textContent = '';
  $('waSync').hidden = true;
  try {
    await api('/api/admin/whatsapp/contacts/skip', {});
    toast('Contacts not imported.', 'ok');
    closeWa();
  } catch (err) { $('waErr').textContent = err.message; await loadWa(); }
};
$('waClose').onclick = closeWa;
$('waModal').onclick = (e) => { if (e.target.id === 'waModal') closeWa(); };
$('waUnlinkBtn').onclick = () => { $('waConfirm').hidden = false; };
$('waUnlinkNo').onclick = () => { $('waConfirm').hidden = true; };
$('waUnlinkYes').onclick = async () => {
  $('waErr').textContent = '';
  $('waConfirm').hidden = true;
  try {
    await api('/api/admin/whatsapp/unlink', {});
    toast('Phone unlinked.', 'ok');
    await loadWa();
    if (!$('waLog').hidden) await loadWaLog();
  }
  catch (err) { $('waErr').textContent = err.message; }
};
$('waLinkBtn').onclick = async () => {
  $('waErr').textContent = '';
  waWaiting = true;
  $('waLinkBtn').hidden = true;
  $('waStatus').textContent = 'Preparing the QR code…';
  try {
    await api('/api/admin/whatsapp/link', {});
    waPoll(1000); // a QR takes a few seconds; don't make the admin wait on a 3s tick
    await loadWa();
  } catch (err) {
    waWaiting = false;
    $('waErr').textContent = err.message;
    await loadWa();
  }
};

// --- boot ---------------------------------------------------------------
// Reveal what was typed. Reset to hidden whenever the login page reappears, so
// one person's password is never left on screen for the next.
function setPwVisible(show) {
  const input = $('login').elements.password;
  input.type = show ? 'text' : 'password';
  $('pwEye').hidden = show;
  $('pwEyeOff').hidden = !show;
  const label = show ? 'Hide password' : 'Show password';
  $('pwToggle').setAttribute('aria-pressed', String(show));
  $('pwToggle').setAttribute('aria-label', label);
  $('pwToggle').title = label;
}
$('pwToggle').onclick = () => {
  setPwVisible($('login').elements.password.type === 'password');
  $('login').elements.password.focus();
};

$('login').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('loginErr').textContent = '';
  $('loginBtn').disabled = true; $('loginBtn').textContent = 'Signing in…';
  try {
    me = (await api('/api/login', { username: f.get('username'), password: f.get('password') })).user;
    start();
  } catch (err) {
    $('loginErr').textContent = err.message;
  } finally { $('loginBtn').disabled = false; $('loginBtn').textContent = 'Sign in'; }
};
$('logout').onclick = async () => { await api('/api/logout', {}); location.reload(); };

function start() {
  expired = false;
  $('loginPage').hidden = true; $('app').hidden = false;
  $('who').textContent = me.name;
  setAvatar($('meAvatar'), me.id, me.name);
  $('menuName').textContent = me.name;
  $('menuRole').textContent = me.is_admin ? 'Administrator' : 'Support agent';
  document.querySelectorAll('.admin-only').forEach((el) => { el.hidden = !me.is_admin; });
  loadChats(); connect();
  setInterval(refreshOpen, 30000); // keeps the window countdown honest
}

api('/api/me').then((d) => { me = d.user; start(); })
  .catch(() => { $('loginPage').hidden = false; setPwVisible(false); });

// --- install to the home screen ------------------------------------------
// Chrome and Edge hand over a real prompt. Safari has no such API on any
// platform, so the only honest thing there is to say where the button is.
const installed = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isSafari = /^((?!chrome|chromium|crios|android|fxios|edg).)*safari/i.test(navigator.userAgent);
// Firefox on Android installs from its own menu and never fires
// beforeinstallprompt, so without this it is the one mobile browser where a
// working feature stays hidden. Firefox on desktop has no install at all, so
// there it is correctly left out rather than given instructions that go nowhere.
const isFirefoxAndroid = /Android/i.test(navigator.userAgent) && /Firefox/i.test(navigator.userAgent);
// On iOS a home-screen web app is installed by Safari. Other iOS browsers are
// the same WebKit engine but do not reliably offer that action, so pointing
// someone at a Share sheet that has no such item is why this "did not work".
const isIOSNonSafari = isIOS && /CriOS|FxiOS|EdgiOS|OPiOS|GSA/i.test(navigator.userAgent);

function refreshInstallOption() {
  const canPrompt = !!window.__installPrompt;
  // On iOS every browser is WebKit — Chrome and Edge there are Safari in a
  // different shell — and all of them add to the home screen through the same
  // Share sheet. Keying this on "is Safari" hid the option in Chrome for
  // iPhone, where it works perfectly well.
  $('installApp').hidden = installed() || !(canPrompt || isIOS || isSafari || isFirefoxAndroid);
}
window.addEventListener('app-installable', refreshInstallOption);
window.addEventListener('appinstalled', () => {
  window.__installPrompt = null;
  $('installApp').hidden = true;
  toast('Installed. Look for the Support Inbox icon on your home screen.', 'ok');
});
refreshInstallOption();

$('installApp').onclick = async () => {
  closeMenu();
  const prompt = window.__installPrompt;
  if (prompt) {
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    // A dismissed prompt cannot be reused; Chrome issues a fresh one later.
    window.__installPrompt = null;
    if (outcome !== 'accepted') refreshInstallOption();
    return;
  }
  // Do not name the browser: the same steps are right in Safari, Chrome and
  // Edge on iOS, and naming one of them reads as "you are in the wrong app".
  $('installSteps').innerHTML = isIOSNonSafari
    ? `On iPhone and iPad only <strong>Safari</strong> can add a web app to the home screen.
       Open <strong>${esc(location.host)}</strong> in Safari, tap <strong>Share</strong>,
       then choose <strong>Add to Home Screen</strong>.`
    : isIOS
      ? 'Tap <strong>Share</strong> in the toolbar, then choose <strong>Add to Home Screen</strong>.'
      : isFirefoxAndroid
        ? 'Open the browser menu (<strong>⋮</strong>) and choose <strong>Install</strong>.'
        : 'In Safari, open the <strong>File</strong> menu and choose <strong>Add to Dock</strong>.';
  $('installModal').hidden = false;
};
const closeInstall = () => { $('installModal').hidden = true; };
$('installClose').onclick = closeInstall;
$('installModal').onclick = (e) => { if (e.target.id === 'installModal') closeInstall(); };

// Registered last so it can never delay first paint. Requires HTTPS (or
// localhost) — on plain HTTP it simply does nothing.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('offline support unavailable:', e.message));
  });
}
