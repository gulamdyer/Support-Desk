/** Flattening a photographed card back to a front-on rectangle.
 *
 *  A licence held up to a phone camera is never a rectangle in the picture —
 *  it is a trapezoid, because the far edge is further away. Rotating cannot
 *  fix that; it needs a projective transform. This works out the four corners
 *  of the card and the matrix that maps them onto a clean rectangle.
 *
 *  Everything here is arithmetic on the pixels already in the browser. No
 *  model, no network.
 *
 *  Kept apart from app.js so the geometry can be run and checked outside a
 *  browser — see src/flatten.test.js.
 */

/** Three box blurs approximate a Gaussian closely enough and cost a fraction
 *  of one. Done by hand rather than with ctx.filter so Node and every browser
 *  measure the same picture. */
function blur(src, W, H, radius = 3) {
  let cur = src;
  for (let pass = 0; pass < 3; pass += 1) {
    const tmp = new Float32Array(W * H);
    for (let y = 0; y < H; y += 1) {          // horizontal
      for (let x = 0; x < W; x += 1) {
        let sum = 0, n = 0;
        for (let d = -radius; d <= radius; d += 1) {
          const xx = x + d;
          if (xx >= 0 && xx < W) { sum += cur[y * W + xx]; n += 1; }
        }
        tmp[y * W + x] = sum / n;
      }
    }
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y += 1) {          // vertical
      for (let x = 0; x < W; x += 1) {
        let sum = 0, n = 0;
        for (let d = -radius; d <= radius; d += 1) {
          const yy = y + d;
          if (yy >= 0 && yy < H) { sum += tmp[yy * W + x]; n += 1; }
        }
        out[y * W + x] = sum / n;
      }
    }
    cur = out;
  }
  return cur;
}

const TH = 180;                                // 1-degree steps of edge normal

/** Vote every strong edge pixel into a (angle, offset) accumulator.
 *
 *  Each pixel votes once, for the angle its own gradient points along, rather
 *  than for every angle a line through it could have. That is both far
 *  cheaper and sharper: a straight card edge piles its whole length into one
 *  cell.
 */
function hough(grey, W, H, minMag) {
  const diag = Math.ceil(Math.hypot(W, H));
  const rhoN = 2 * diag + 1;
  const acc = new Float32Array(TH * rhoN);
  const cos = new Float32Array(TH), sin = new Float32Array(TH);
  for (let t = 0; t < TH; t += 1) {
    cos[t] = Math.cos((t * Math.PI) / 180);
    sin[t] = Math.sin((t * Math.PI) / 180);
  }
  for (let y = 1; y < H - 1; y += 1) {
    for (let x = 1; x < W - 1; x += 1) {
      const i = y * W + x;
      const gx = grey[i - W + 1] + 2 * grey[i + 1] + grey[i + W + 1]
               - grey[i - W - 1] - 2 * grey[i - 1] - grey[i + W - 1];
      const gy = grey[i + W - 1] + 2 * grey[i + W] + grey[i + W + 1]
               - grey[i - W - 1] - 2 * grey[i - W] - grey[i - W + 1];
      const mag = Math.hypot(gx, gy);
      if (mag < minMag) continue;
      let t = Math.round((Math.atan2(gy, gx) * 180) / Math.PI);
      t = ((t % TH) + TH) % TH;               // a line has no front or back
      const rho = Math.round(x * cos[t] + y * sin[t]) + diag;
      acc[t * rhoN + rho] += mag;
    }
  }
  return { acc, rhoN, diag, cos, sin };
}

/** The strongest candidate lines of one orientation.
 *
 *  Local maxima in the accumulator, thinned so one thick edge does not fill
 *  the list with copies of itself, scored against this band's own best rather
 *  than the picture's — a card is wider than it is tall, so its short sides
 *  never poll as strongly as its long ones and a shared threshold loses them
 *  completely.
 */
function candidates(h, W, H, band, keep = 20) {
  const { acc, rhoN, cos, sin } = h;
  // How far the line passes from two fixed points. Unsigned, because an angle
  // folded into half a turn leaves the normal free to point either way, so the
  // sign of a single distance says nothing; two of them pin a line down.
  const marks = (l) => [
    Math.abs((W / 2) * cos[l.t] + (H / 2) * sin[l.t] - l.rho),
    Math.abs(l.rho),
  ];
  let top = 0;
  for (const t of band) for (let r = 0; r < rhoN; r += 1) top = Math.max(top, acc[t * rhoN + r]);
  const found = [];
  for (const t of band) {
    for (let r = 1; r < rhoN - 1; r += 1) {
      const v = acc[t * rhoN + r];
      // A low bar on purpose. Perspective makes one side of a card far
      // brighter in the accumulator than the one opposite — measured 7:1 on a
      // card held close — so a threshold set to catch the strong edge loses
      // its partner and no quadrilateral can be formed at all. Let the weak
      // ones through and let the support test throw them out.
      if (v < top * 0.05) continue;
      if (v < acc[t * rhoN + r - 1] || v < acc[t * rhoN + r + 1]) continue;
      found.push({ t, rho: r - h.diag, v });
    }
  }
  found.sort((a, b) => b.v - a.v);
  const out = [];
  for (const line of found) {
    // One edge lights several neighbouring cells, at shifting rho as the angle
    // turns; judge sameness by where the lines actually run, and keep the best
    // of each group.
    const m = marks(line);
    if (out.some((o) => {
      const n = marks(o);
      return Math.abs(n[0] - m[0]) < 8 && Math.abs(n[1] - m[1]) < 8
        && Math.abs(o.t - line.t) < 14;
    })) continue;
    out.push(line);
    if (out.length === keep) break;
  }
  return out;
}

/** How much of an edge is really there.
 *
 *  This is what separates a card's border from a line of print running
 *  parallel to it. Both peak in the accumulator; only the border has an edge
 *  under every step of the way from one corner to the next. Votes alone cannot
 *  tell them apart, because the accumulator has no idea where along the line
 *  they came from.
 */
function support(grey, W, H, a, b, minMag) {
  const N = 64;
  const nx = (b[0] - a[0]) / Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ny = (b[1] - a[1]) / Math.hypot(b[0] - a[0], b[1] - a[1]);
  let hits = 0, seen = 0;
  for (let i = 0; i <= N; i += 1) {
    const px = a[0] + (b[0] - a[0]) * (i / N);
    const py = a[1] + (b[1] - a[1]) * (i / N);
    let ok = false;
    for (let off = -2; off <= 2 && !ok; off += 1) {     // allow a pixel or two of slop
      const x = Math.round(px - ny * off), y = Math.round(py + nx * off);
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
      const j = y * W + x;
      const gx = grey[j - W + 1] + 2 * grey[j + 1] + grey[j + W + 1]
               - grey[j - W - 1] - 2 * grey[j - 1] - grey[j + W - 1];
      const gy = grey[j + W - 1] + 2 * grey[j + W] + grey[j + W + 1]
               - grey[j - W - 1] - 2 * grey[j - W] - grey[j - W + 1];
      if (Math.hypot(gx, gy) < minMag) continue;
      // The gradient of a real edge points across the line, not along it.
      ok = Math.abs(gx * nx + gy * ny) / Math.hypot(gx, gy) < 0.34;   // within ~20 degrees
    }
    if (px >= 0 && py >= 0 && px < W && py < H) { seen += 1; if (ok) hits += 1; }
  }
  return seen ? hits / seen : 0;
}

/** Where two lines cross, in image coordinates. */
const intersect = (a, b, cos, sin) => {
  const det = cos[a.t] * sin[b.t] - sin[a.t] * cos[b.t];
  if (Math.abs(det) < 1e-6) return null;                   // parallel
  return [(a.rho * sin[b.t] - b.rho * sin[a.t]) / det,
          (b.rho * cos[a.t] - a.rho * cos[b.t]) / det];
};

/** Find the card. Returns its four corners clockwise from the top left, in the
 *  coordinates of the greyscale passed in, or null when nothing card-shaped
 *  stands out — an honest "no" beats a confident wrong quadrilateral.
 *
 *  Candidate lines are cheap and mostly wrong, so every workable pair of them
 *  is turned into a quadrilateral and made to prove itself: all four sides
 *  have to be continuously present in the picture. Of those that pass, the
 *  largest wins, which is what stops a box drawn round the printed text
 *  beating the box drawn round the card.
 */
export function findCard(greyRaw, W, H) {
  // Low on purpose. A card's four sides are not equally visible: measured on a
  // pink ID card on a steel table, three edges gave gradients around 40-66 and
  // the fourth only 12, because there the card and the table are the same
  // brightness. Colour does not rescue it — that edge is weak in every
  // channel. So the bar for "an edge is here" has to sit under the worst side,
  // and the work of telling a card from a stray line is left to whether all
  // four sides hold up along their whole length.
  const MIN_MAG = 10;
  const grey = blur(greyRaw, W, H, 3);
  const h = hough(grey, W, H, MIN_MAG);
  const { acc, rhoN, cos, sin } = h;

  // Which way do the strongest edges run? A rectangle answers twice, ninety
  // degrees apart, so the two families are scored together and only the first
  // has to be found.
  const byAngle = new Float32Array(TH);
  for (let t = 0; t < TH; t += 1) {
    for (let r = 0; r < rhoN; r += 1) byAngle[t] += acc[t * rhoN + r];
  }
  // The strongest direction, and a band around it wide enough to hold both of
  // the sides that run that way. They are NOT parallel: seen from an angle a
  // rectangle's opposite sides converge, and on a card filling the frame the
  // near and far sides were measured 38 degrees apart. Wide bands, and no
  // assumption that the second pair sits at a right angle to the first.
  let one = 0;
  for (let t = 0; t < TH; t += 1) if (byAngle[t] > byAngle[one]) one = t;
  const away = (a, b) => { const d = Math.abs(a - b) % TH; return Math.min(d, TH - d); };

  const near = [], far = [];
  for (let t = 0; t < TH; t += 1) (away(t, one) <= 32 ? near : far).push(t);
  const A = candidates(h, W, H, near);
  const B = candidates(h, W, H, far);
  if (A.length < 2 || B.length < 2) return null;

  // Two sides of a card lie either side of the middle of the picture, a good
  // way apart. Testing that needs care: angles are folded into half a turn, so
  // one side's normal points inward and the other's outward, and the two
  // opposite edges of a card report distances of the SAME sign — which read
  // naively says "these are the same line" and threw the card away. Line up
  // the normals first, then the signs mean what they look like.
  const cx = W / 2, cy = H / 2;
  const gap = Math.min(W, H) * 0.2;
  const apart = (p, q) => {
    const flip = cos[p.t] * cos[q.t] + sin[p.t] * sin[q.t] < 0 ? -1 : 1;
    const sp = cx * cos[p.t] + cy * sin[p.t] - p.rho;
    const sq = (cx * cos[q.t] + cy * sin[q.t] - q.rho) * flip;
    return sp * sq < 0 && Math.abs(sp) + Math.abs(sq) > gap;
  };

  let best = null;
  for (let i = 0; i < A.length; i += 1) for (let j = i + 1; j < A.length; j += 1) {
    if (!apart(A[i], A[j])) continue;
    for (let k = 0; k < B.length; k += 1) for (let l = k + 1; l < B.length; l += 1) {
      if (!apart(B[k], B[l])) continue;
      const pts = [];
      for (const p of [A[i], A[j]]) for (const q of [B[k], B[l]]) {
        const hit = intersect(p, q, cos, sin);
        if (hit) pts.push(hit);
      }
      if (pts.length < 4) continue;
      const quad = orderCorners(pts, W, H);
      if (!quad) continue;
      if (best && quad.area <= best.area) continue;   // could not win; do not score it
      let sum = 0, ok = true;
      for (let n = 0; n < 4 && ok; n += 1) {
        sum += support(grey, W, H, quad[n], quad[(n + 1) % 4], MIN_MAG);
        ok = sum >= 0.55 * (n + 1);                   // give up early on a hopeless side
      }
      if (!ok || sum / 4 < 0.72) continue;
      best = quad;
    }
  }
  return best;
}

/** Clockwise from the top left, so the destination rectangle lines up. */
function orderCorners(pts, W, H) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const sorted = [...pts].sort((p, q) =>
    Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(q[1] - cy, q[0] - cx));
  // atan2 starts at due east, so the run begins in the top-right quadrant;
  // rotate until the first point is the one nearest the top-left corner.
  let start = 0, near = Infinity;
  for (let i = 0; i < 4; i += 1) {
    const d = Math.hypot(sorted[i][0], sorted[i][1]);
    if (d < near) { near = d; start = i; }
  }
  const out = [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]);
  // A quadrilateral that folds over itself, or one that covers almost none of
  // the picture, is a bad read rather than a small card.
  const area = Math.abs(out.reduce((s, p, i) => {
    const q = out[(i + 1) % 4];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0)) / 2;
  if (area < W * H * 0.12) return null;
  out.area = area;
  return out;
}

/** The 3x3 projective transform taking four source points to four
 *  destinations. Eight unknowns, eight equations, solved by elimination. */
export function homography(src, dst) {
  const A = [], y = [];
  for (let i = 0; i < 4; i += 1) {
    const [x1, y1] = src[i], [u, v] = dst[i];
    A.push([x1, y1, 1, 0, 0, 0, -u * x1, -u * y1]); y.push(u);
    A.push([0, 0, 0, x1, y1, 1, -v * x1, -v * y1]); y.push(v);
  }
  for (let c = 0; c < 8; c += 1) {                 // partial pivoting
    let p = c;
    for (let r = c + 1; r < 8; r += 1) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [y[c], y[p]] = [y[p], y[c]];
    if (Math.abs(A[c][c]) < 1e-9) return null;     // degenerate quad
    for (let r = 0; r < 8; r += 1) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k += 1) A[r][k] -= f * A[c][k];
      y[r] -= f * y[c];
    }
  }
  const h = y.map((v, i) => v / A[i][i]);
  return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
}

// app.js is a plain script and cannot import; hand it the two entry points.
if (typeof window !== 'undefined') Object.assign(window, { findCard, homography });
