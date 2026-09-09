/** Flattening a card photographed at an angle.
 *
 *  Built as a picture with a known answer: a card is drawn through a chosen
 *  projection onto a background, printing and all, and the detector has to
 *  give the four corners back. The printing matters — lines of text run
 *  parallel to the card's edges and out-vote them in the accumulator, which is
 *  the mistake this is really guarding against.
 */
import assert from 'node:assert';
import { findCard, homography } from '../public/flatten.js';

const W = 720, H = 400;
// A card seen from below and to the right: the far side smaller, the sides
// converging hard. Taken from a real photograph of an Emirates ID.
const CORNERS = [[114, 41], [582, 49], [695, 342], [6, 354]];

const grey = new Float32Array(W * H).fill(70);        // the table
{
  const CW = 400, CH = 252;                           // the card, face on
  const card = (u, v) => {
    if (u < 0 || v < 0 || u >= CW || v >= CH) return null;
    const rows = [30, 60, 90, 120, 150, 180, 210];    // lines of print
    if (rows.some((r) => v > r && v < r + 9 && u > 40 && u < 300)) return 25;
    return 205;                                       // card stock
  };
  // Walk the source picture and ask, for each pixel, what the card shows there.
  const fwd = homography(CORNERS, [[0, 0], [CW, 0], [CW, CH], [0, CH]]);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const w = fwd[2][0] * x + fwd[2][1] * y + fwd[2][2];
      const ink = card((fwd[0][0] * x + fwd[0][1] * y + fwd[0][2]) / w,
                       (fwd[1][0] * x + fwd[1][1] * y + fwd[1][2]) / w);
      if (ink !== null) grey[y * W + x] = ink;
    }
  }
}

let n = 0;
const check = (label, fn) => { fn(); n += 1; console.log(`  ✓ ${label}`); };

check('a homography maps its four points exactly', () => {
  const m = homography([[0, 0], [10, 0], [10, 10], [0, 10]], CORNERS);
  [[0, 0], [10, 0], [10, 10], [0, 10]].forEach(([x, y], i) => {
    const w = m[2][0] * x + m[2][1] * y + m[2][2];
    assert.ok(Math.abs((m[0][0] * x + m[0][1] * y + m[0][2]) / w - CORNERS[i][0]) < 1e-6);
    assert.ok(Math.abs((m[1][0] * x + m[1][1] * y + m[1][2]) / w - CORNERS[i][1]) < 1e-6);
  });
});

check('four points in a line have no transform', () => {
  assert.equal(homography([[0, 0], [1, 1], [2, 2], [3, 3]], CORNERS), null);
});

const found = findCard(grey, W, H);

check('the card is found', () => assert.ok(found, 'no quadrilateral returned'));

// A corner is where two lines meet, so it carries the error of both, and the
// shallower they cross the more it is magnified — a side found to within a
// pixel can still put its corner out by several. Eight pixels in 720 is under
// a percent of the width, and invisible once the card is redrawn.
check('every corner lands within a few pixels', () => {
  const off = found.map((p, i) => Math.hypot(p[0] - CORNERS[i][0], p[1] - CORNERS[i][1]));
  assert.ok(Math.max(...off) < 8, `corners out by ${off.map((d) => d.toFixed(1)).join(', ')}px`);
});

// The failure this replaces: the strongest lines in the picture are the seven
// rows of print, not the card's border, and a detector that trusts strength
// draws its box round the text.
check('the printing does not win', () => {
  const area = Math.abs(found.reduce((s, p, i) => {
    const q = found[(i + 1) % 4];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0)) / 2;
  const want = Math.abs(CORNERS.reduce((s, p, i) => {
    const q = CORNERS[(i + 1) % 4];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0)) / 2;
  assert.ok(area > want * 0.93, `covered ${(100 * area / want).toFixed(0)}% of the card`);
});

// An honest "no" beats a confident wrong answer: with nothing card-shaped
// there, the button must leave the photo alone.
check('an empty picture is refused', () => {
  assert.equal(findCard(new Float32Array(W * H).fill(120), W, H), null);
});

check('noise alone is refused', () => {
  const noise = new Float32Array(W * H);
  let seed = 7;
  for (let i = 0; i < noise.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = (seed % 256);
  }
  assert.equal(findCard(noise, W, H), null);
});

console.log(`✅ flatten: ${n}/${n} — a slanted card is found and squared up`);
