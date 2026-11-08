/**
 * What the pilot can see in a Velocidrone FPV frame: where the horizon is and
 * where the next gate is.
 *
 *  - Horizon: the far edge of the bright grass, per column, fitted with a
 *    robust line. Slope is roll, height is pitch. Trees, gates and hills sit
 *    on that edge but are darker or bluer than the grass, so they end it
 *    rather than extend it.
 *  - Next gate: Velocidrone draws orange circular arrows inside the next
 *    checkpoint. Their centroid and extent are the target, and the marker
 *    moves on by itself, so following it is following the course.
 *
 * Frames are RGB24, top-left origin, already cropped to the picture (no
 * letterbox) — see vd-fly.ts.
 */

export interface Seen {
  /** Horizon at the image centre column, y in px (down positive); NaN if none. */
  horizonY: number;
  /** dy/dx of the horizon line. */
  horizonSlope: number;
  /** Fraction of columns where grass was found. */
  horizonCover: number;
  /** Next-gate marker centroid and size, px; null if not in view. */
  gate: { x: number; y: number; w: number; h: number; px: number; edge: '' | 'left' | 'right' | 'top' | 'bottom' } | null;
}

function isGrass(r: number, g: number, b: number): boolean {
  // Sunlit yellow-green: green leads blue clearly, red is close behind green.
  return g > 110 && g > b + 45 && r > g * 0.6 && r < g * 1.15;
}

function isOrange(r: number, g: number, b: number): boolean {
  // The marker is ~(190, 120, 45). The gazebo roof and the WDC logos are
  // orange-ish too but sit outside these bands (sampled from the pad view).
  const rg = r - g;
  const gb = g - b;
  return r > 160 && rg > 45 && rg < 100 && gb > 50 && gb < 105;
}

export function look(rgb: Uint8Array, w: number, h: number): Seen {
  // ---- horizon: for each sampled column, scan up from 85% of the height and
  // find where a run of grass ends.
  const xs: number[] = [];
  const ys: number[] = [];
  const step = Math.max(1, Math.floor(w / 96));
  for (let x = 0; x < w; x += step) {
    let y = Math.floor(h * 0.85);
    // find grass first (the pad and the quad's own frame can be at the bottom)
    while (y > 0) {
      const i = (y * w + x) * 3;
      if (isGrass(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!)) break;
      y--;
    }
    if (y <= 0) continue;
    let miss = 0;
    let top = y;
    while (y > 0 && miss < 3) {
      const i = (y * w + x) * 3;
      if (isGrass(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!)) {
        top = y;
        miss = 0;
      } else miss++;
      y--;
    }
    xs.push(x);
    ys.push(top);
  }
  let horizonY = NaN;
  let horizonSlope = 0;
  if (xs.length >= 8) {
    // Theil-Sen: median of pairwise slopes, then median intercept. Robust to
    // the columns where a tree or a gate post ends the grass early.
    const slopes: number[] = [];
    for (let a = 0; a < xs.length; a += 2) {
      for (let b = a + 3; b < xs.length; b += 3) slopes.push((ys[b]! - ys[a]!) / (xs[b]! - xs[a]!));
    }
    slopes.sort((p, q) => p - q);
    horizonSlope = slopes[Math.floor(slopes.length / 2)] ?? 0;
    const cx = w / 2;
    const ints = xs.map((x, i) => ys[i]! - horizonSlope * (x - cx)).sort((p, q) => p - q);
    // The grass edge is pulled *down* by objects standing on it, never up, so
    // take an upper quantile rather than the median.
    horizonY = ints[Math.floor(ints.length * 0.3)]!;
  }

  // ---- gate marker: orange pixels binned into 16 px cells; the densest
  // 3x3 block of cells is the marker, so a stray orange thing elsewhere on
  // screen does not drag the centroid.
  const C = 16;
  const cw = Math.ceil(w / C);
  const ch = Math.ceil(h / C);
  const cells = new Int32Array(cw * ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      if (isOrange(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!)) cells[((y / C) | 0) * cw + ((x / C) | 0)]!++;
    }
  }
  let best = 0;
  let bx = -1;
  let by = -1;
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = cy + dy;
          const xx = cx + dx;
          if (yy >= 0 && yy < ch && xx >= 0 && xx < cw) sum += cells[yy * cw + xx]!;
        }
      }
      if (sum > best) {
        best = sum;
        bx = cx;
        by = cy;
      }
    }
  }
  let gate: Seen['gate'] = null;
  if (best >= 10) {
    // Grow the block while neighbouring cells still hold marker pixels: up
    // close the marker spans many cells.
    let c0 = bx - 1, c1 = bx + 1, r0 = by - 1, r1 = by + 1;
    const colHas = (cx: number): boolean => { for (let cy = r0; cy <= r1; cy++) if (cy >= 0 && cy < ch && cx >= 0 && cx < cw && cells[cy * cw + cx]! > 2) return true; return false; };
    const rowHas = (cy: number): boolean => { for (let cx = c0; cx <= c1; cx++) if (cy >= 0 && cy < ch && cx >= 0 && cx < cw && cells[cy * cw + cx]! > 2) return true; return false; };
    for (let k = 0; k < 40; k++) {
      let grew = false;
      if (c0 > 0 && colHas(c0 - 1)) { c0--; grew = true; }
      if (c1 < cw - 1 && colHas(c1 + 1)) { c1++; grew = true; }
      if (r0 > 0 && rowHas(r0 - 1)) { r0--; grew = true; }
      if (r1 < ch - 1 && rowHas(r1 + 1)) { r1++; grew = true; }
      if (!grew) break;
    }
    let n = 0, sx = 0, sy = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
    for (let y = Math.max(0, r0 * C); y < Math.min(h, (r1 + 1) * C); y++) {
      for (let x = Math.max(0, c0 * C); x < Math.min(w, (c1 + 1) * C); x++) {
        const i = (y * w + x) * 3;
        if (isOrange(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!)) {
          n++; sx += x; sy += y;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    // The marker (and the edge arrow) is about as tall as it is wide; the
    // gazebo roof's edge is orange too and came through as a 36x7 strip that
    // won the cluster contest on the first frames of flight 2.
    const squarish = bh * 2.5 >= bw && bw * 2.5 >= bh;
    if (n >= 10 && squarish) {
      // Off screen, Velocidrone draws an orange arrow at the edge pointing to
      // the gate. It says which way, not where: it must not be read as a
      // gate sitting at the bottom of the picture (the first flight did,
      // cut the throttle and chased the arrow round in a circle).
      const m = 10;
      const edge = x0 < m ? 'left' : x1 > w - m ? 'right' : y1 > h - m - 4 ? 'bottom' : y0 < m ? 'top' : '';
      gate = { x: sx / n, y: sy / n, w: x1 - x0 + 1, h: y1 - y0 + 1, px: n, edge };
    }
  }
  return { horizonY, horizonSlope, horizonCover: xs.length / Math.ceil(w / step), gate };
}
