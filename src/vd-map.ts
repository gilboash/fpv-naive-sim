/**
 * The course map for an imported Velocidrone track: how the line goes through
 * every gate and past every pole, and the place to correct it.
 *
 * Velocidrone's file says which way a gate faces but not how a flag is passed
 * (see src/render/velocidrone.ts), so the import has to guess some of it, and
 * the person who knows the track is the authority. This draws exactly what the
 * import produced — the same `trackFromSaved` the sim and the learning pilot
 * use — so what is corrected here is what gets flown.
 *
 * Dev server only: the tracks come from `virtual:local-tracks`, which a build
 * resolves to nothing, and saving goes to a middleware that exists only under
 * `npm run dev`.
 */

import localVd from 'virtual:local-tracks';
import type { Obstacle } from './flight/collision.ts';
import type { Checkpoint } from './race/course.ts';
import { MeshBuilder } from './render/mesh.ts';
import { type Imported, type SavedVdTrack, trackFromSaved, type VdOverride } from './render/velocidrone.ts';

const SVG = 'http://www.w3.org/2000/svg';
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const svg = document.getElementById('map') as unknown as SVGSVGElement;
const trackSel = $<HTMLSelectElement>('track');
const selBox = $('sel');
const saveBtn = $<HTMLButtonElement>('save');
const revertBtn = $<HTMLButtonElement>('revert');
const status = $('status');
const list = $<HTMLTableElement>('list');

const tracks = localVd as SavedVdTrack[];
let saved: SavedVdTrack | null = null;
let overrides: Record<number, VdOverride> = {};
let dirty = false;
let selected = -1;
let imp: Imported | null = null;
let obstacles: Obstacle[] = [];
const vb = { x: 0, y: 0, w: 100, h: 100 };

/**
 * A flown run to draw over the course: `?flight=<path to a lap.json>`, as
 * `npm run learn` writes it. The dev server serves the project directory, so
 * measurements/learned/... is reachable here and nowhere else.
 */
let flight: { t: number; n: number; e: number; u: number; speed: number; thr: number; roll: number; pitch: number; yaw: number }[] = [];
/** Play-back position, an index into `flight`; -1 when nothing is loaded. */
let playAt = -1;
let playing = false;
let flightLaps: number[] = [];
const flightPath = new URLSearchParams(location.search).get('flight');
if (flightPath) {
  fetch(flightPath)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((j: { samples: { t: number; n: number; e: number; u: number; throttle?: number; roll?: number; pitch?: number; yaw?: number }[]; laps: number[] }) => {
      const sm = j.samples;
      flight = sm.map((p, i) => {
        const q = sm[Math.min(sm.length - 1, i + 1)]!;
        const o = sm[Math.max(0, i - 1)]!;
        const dt = q.t - o.t || 1;
        return {
          t: p.t, n: p.n, e: p.e, u: p.u,
          speed: Math.hypot(q.n - o.n, q.e - o.e, q.u - o.u) / dt,
          thr: p.throttle ?? 0, roll: p.roll ?? 0, pitch: p.pitch ?? 0, yaw: p.yaw ?? 0,
        };
      });
      flightLaps = j.laps;
      playAt = 0;
      setupPlayer();
      draw();
    })
    .catch((e) => (status.textContent = `could not load ${flightPath}: ${String(e)}`));
}

const player = document.createElement('div');

/** Play / scrub controls, with the sticks as the bot held them. */
function setupPlayer(): void {
  player.innerHTML = `<h2>Play-back</h2>
    <div class="row"><button id="pp">▶ Play</button>
    <select id="rate"><option value="0.25">¼×</option><option value="0.5">½×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select></div>
    <input id="scrub" type="range" min="0" max="${flight.length - 1}" value="0" style="width:100%">
    <p id="readout" style="font-variant-numeric:tabular-nums"></p>`;
  selBox.before(player);
  const pp = player.querySelector('#pp') as HTMLButtonElement;
  const scrub = player.querySelector('#scrub') as HTMLInputElement;
  const rate = player.querySelector('#rate') as HTMLSelectElement;
  scrub.oninput = () => {
    playAt = Number(scrub.value);
    draw();
  };
  pp.onclick = () => {
    playing = !playing;
    pp.textContent = playing ? '❚❚ Pause' : '▶ Play';
    if (playing && playAt >= flight.length - 1) playAt = 0;
    let last = performance.now();
    let tSim = flight[playAt]!.t;
    const tick = (now: number): void => {
      if (!playing) return;
      tSim += ((now - last) / 1000) * Number(rate.value);
      last = now;
      while (playAt < flight.length - 1 && flight[playAt + 1]!.t <= tSim) playAt++;
      scrub.value = String(playAt);
      draw();
      if (playAt >= flight.length - 1) {
        playing = false;
        pp.textContent = '▶ Play';
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
}

function drawPlayhead(): void {
  if (playAt < 0 || !flight[playAt]) return;
  const p = flight[playAt]!;
  const q = flight[Math.min(flight.length - 1, playAt + 6)]!;
  const g = el('g', {}, svg);
  // A short tail, so the direction of travel reads.
  const tail = flight.slice(Math.max(0, playAt - 60), playAt + 1).map((f) => `${X(f.e)},${Y(f.n)}`).join(' ');
  el('polyline', { points: tail, fill: 'none', stroke: 'var(--ink)', 'stroke-width': 0.35, 'stroke-opacity': 0.8 }, g);
  el('circle', { cx: X(p.e), cy: Y(p.n), r: 0.7, fill: '#fff', stroke: '#000', 'stroke-width': 0.15 }, g);
  el('line', { x1: X(p.e), y1: Y(p.n), x2: X(p.e + (q.e - p.e) * 3), y2: Y(p.n + (q.n - p.n) * 3), stroke: '#fff', 'stroke-width': 0.2, 'marker-end': 'url(#head)' }, g);
  // Lap clock: race time from the hole shot.
  const ro = player.querySelector('#readout');
  if (ro) {
    ro.textContent = `t ${p.t.toFixed(2)} s · ${(p.speed * 3.6).toFixed(0)} km/h · ${p.u.toFixed(1)} m up · ` +
      `thr ${(p.thr * 100).toFixed(0)}% roll ${p.roll.toFixed(2)} pitch ${p.pitch.toFixed(2)} yaw ${p.yaw.toFixed(2)}`;
  }
}

/** Speed colour ramp, slow blue to fast red, in buckets so the path is a few elements. */
const RAMP = ['#3b5bdb', '#1c7ed6', '#15aabf', '#2b9348', '#94d82d', '#fab005', '#fd7e14', '#e03131'];

function drawFlight(): void {
  if (flight.length < 2) return;
  const g = el('g', { fill: 'none', 'stroke-width': 0.22, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.9 }, svg);
  const vmax = Math.max(...flight.map((p) => p.speed));
  const bucket = (v: number): number => Math.min(RAMP.length - 1, Math.floor((v / vmax) * RAMP.length));
  let run: string[] = [];
  let b = bucket(flight[0]!.speed);
  const flush = (): void => {
    if (run.length > 1) el('polyline', { points: run.join(' '), stroke: RAMP[b]! }, g);
  };
  for (const p of flight) {
    const nb = bucket(p.speed);
    run.push(`${X(p.e)},${Y(p.n)}`);
    if (nb !== b) {
      flush();
      run = [run[run.length - 1]!];
      b = nb;
    }
  }
  flush();
  const k = el('g', {}, svg);
  const x0 = vb.x + 1.5;
  const y0 = vb.y + 2;
  el('text', { x: x0, y: y0, 'font-size': 1.2, fill: 'var(--ink)', 'font-weight': 700 }, k).textContent =
    `flown: laps ${flightLaps.map((t) => t.toFixed(2)).join(' / ')} s`;
  RAMP.forEach((c, i) => {
    el('rect', { x: x0 + i * 2.2, y: y0 + 0.8, width: 2.2, height: 0.8, fill: c }, k);
  });
  el('text', { x: x0, y: y0 + 3, 'font-size': 0.9, fill: 'var(--muted)' }, k).textContent = '0';
  el('text', { x: x0 + RAMP.length * 2.2, y: y0 + 3, 'font-size': 0.9, fill: 'var(--muted)', 'text-anchor': 'end' }, k).textContent =
    `${(vmax * 3.6).toFixed(0)} km/h`;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent.appendChild(e);
  return e;
}

// Map space: x = east, y = -north, so north is up.
const X = (east: number): number => east;
const Y = (north: number): number => -north;

const headingOf = (cp: Checkpoint): number => ((Math.atan2(cp.dirE, cp.dirN) * 180) / Math.PI + 360) % 360;

function arrow(g: Element, n0: number, e0: number, n1: number, e1: number, colour: string, width: number, dash = ''): void {
  el('line', { x1: X(e0), y1: Y(n0), x2: X(e1), y2: Y(n1), stroke: colour, 'stroke-width': width, 'stroke-dasharray': dash, 'marker-end': 'url(#head)' }, g);
}

function load(i: number): void {
  saved = tracks[i] ?? null;
  overrides = structuredClone(saved?.overrides ?? {});
  dirty = false;
  selected = -1;
  build(true);
}

function build(fit = false): void {
  if (!saved) return;
  imp = trackFromSaved({ ...saved, overrides });
  obstacles = [];
  imp.track.build(new MeshBuilder(), obstacles);
  $('title').textContent = saved.name;
  if (fit) {
    let minN = Infinity, maxN = -Infinity, minE = Infinity, maxE = -Infinity;
    for (const cp of [...imp.course.checkpoints, { north: imp.course.start.north, east: imp.course.start.east }]) {
      minN = Math.min(minN, cp.north); maxN = Math.max(maxN, cp.north);
      minE = Math.min(minE, cp.east); maxE = Math.max(maxE, cp.east);
    }
    const pad = 6;
    vb.x = minE - pad;
    vb.y = -maxN - pad;
    vb.w = maxE - minE + 2 * pad;
    vb.h = maxN - minN + 2 * pad;
  }
  draw();
  panel();
  table();
}

function draw(): void {
  if (!imp) return;
  svg.replaceChildren();
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const defs = el('defs', {}, svg);
  const m = el('marker', { id: 'head', viewBox: '0 0 10 10', refX: 7, refY: 5, markerWidth: 4, markerHeight: 4, orient: 'auto-start-reverse' }, defs);
  el('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'context-stroke' }, m);
  const ink = 'var(--ink)';
  const muted = 'var(--muted)';

  // A 5 m grid, so distances can be read off.
  const grid = el('g', { stroke: 'var(--line)', 'stroke-width': 0.05 }, svg);
  for (let e = Math.floor(vb.x / 5) * 5; e < vb.x + vb.w; e += 5) el('line', { x1: e, y1: vb.y, x2: e, y2: vb.y + vb.h }, grid);
  for (let y = Math.floor(vb.y / 5) * 5; y < vb.y + vb.h; y += 5) el('line', { x1: vb.x, y1: y, x2: vb.x + vb.w, y2: y }, grid);

  // Scenery, as footprints.
  const sc = el('g', { fill: muted, 'fill-opacity': 0.22, stroke: 'none' }, svg);
  for (const o of obstacles) {
    if (o.kind === 'box') {
      el('rect', { x: X(o.minEast), y: Y(o.maxNorth), width: o.maxEast - o.minEast, height: o.maxNorth - o.minNorth }, sc);
    } else if (o.kind === 'cylinder' || (o.kind === 'ring' && o.axis === 'up')) {
      el('circle', { cx: X(o.east), cy: Y(o.north), r: o.radius }, sc);
    } else {
      const alongN = o.axis === 'north';
      const hn = alongN ? o.halfLength : o.radius;
      const he = alongN ? o.radius : o.halfLength;
      el('rect', { x: X(o.east - he), y: Y(o.north + hn), width: 2 * he, height: 2 * hn }, sc);
    }
  }

  // The line, as the import assumes it: straight from each exit to the next entry.
  const cps = imp.course.checkpoints;
  const pts: string[] = [];
  const s = imp.course.start;
  pts.push(`${X(s.east)},${Y(s.north)}`);
  for (const p of imp.passes) pts.push(`${X(p.entry[1])},${Y(p.entry[0])}`, `${X(p.exit[1])},${Y(p.exit[0])}`);
  pts.push(`${X(imp.passes[0]!.entry[1])},${Y(imp.passes[0]!.entry[0])}`);
  el('polyline', { points: pts.join(' '), fill: 'none', stroke: 'var(--accent)', 'stroke-opacity': 0.35, 'stroke-width': 0.25, 'stroke-linejoin': 'round' }, svg);

  drawFlight();

  // Start grid.
  const yaw = (s.yawDeg * Math.PI) / 180;
  const sg = el('g', {}, svg);
  el('polygon', {
    points: [
      [s.north + Math.cos(yaw) * 1.4, s.east + Math.sin(yaw) * 1.4],
      [s.north - Math.cos(yaw) * 0.8 - Math.sin(yaw) * 0.9, s.east - Math.sin(yaw) * 0.8 + Math.cos(yaw) * 0.9],
      [s.north - Math.cos(yaw) * 0.8 + Math.sin(yaw) * 0.9, s.east - Math.sin(yaw) * 0.8 - Math.cos(yaw) * 0.9],
    ].map(([n, e]) => `${X(e!)},${Y(n!)}`).join(' '),
    fill: '#2a9d4b',
  }, sg);
  el('text', { x: X(s.east) + 1.6, y: Y(s.north) + 0.4, 'font-size': 1.1, fill: '#2a9d4b' }, sg).textContent = 'START';

  // Labels are placed after everything else and pushed apart: on this kind of
  // track poles stand on gate posts and gates stack, so the natural spots collide.
  const labels: { n: number; e: number; text: string; colour: string; g: Element }[] = [];
  cps.forEach((cp, i) => {
    const n = imp!.table[i]!.gate;
    const g = el('g', { 'data-i': i, style: 'cursor:pointer' }, svg);
    const sel = i === selected;
    const hand = overrides[n] !== undefined;
    const labelCol = hand ? 'var(--accent)' : ink;
    // Something easy to click.
    el('circle', { cx: X(cp.east), cy: Y(cp.north), r: 2.2, fill: sel ? 'var(--accent)' : 'transparent', 'fill-opacity': sel ? 0.15 : 0 }, g);
    const aN = -cp.dirE; // across the direction of travel, NE components
    const aE = cp.dirN;
    if (cp.kind === 'gate') {
      const upper = cp.up > 2.4;
      const colour = '#d39b00';
      if (cp.dirU && Math.abs(cp.dirU) > 0.999) {
        el('rect', { x: X(cp.east - cp.halfWidth), y: Y(cp.north + cp.halfHeight), width: 2 * cp.halfWidth, height: 2 * cp.halfHeight, fill: 'none', stroke: colour, 'stroke-width': 0.25 }, g);
        el('text', { x: X(cp.east), y: Y(cp.north) + 0.55, 'font-size': 1.5, 'text-anchor': 'middle', fill: ink, 'font-weight': 700 }, g).textContent = cp.dirU < 0 ? '↓' : '↑';
        labels.push({ n: cp.north, e: cp.east + cp.halfWidth + 1.2, text: String(n), colour: labelCol, g });
        return;
      } else {
        el('line', {
          x1: X(cp.east - aE * cp.halfWidth), y1: Y(cp.north - aN * cp.halfWidth),
          x2: X(cp.east + aE * cp.halfWidth), y2: Y(cp.north + aN * cp.halfWidth),
          stroke: colour, 'stroke-width': 0.45, 'stroke-dasharray': upper ? '0.6 0.4' : '', 'stroke-linecap': 'round',
        }, g);
        // Upper gates of a stack get their arrow shifted a little, so a pair is two arrows.
        const off = upper ? 0.55 : -0.0;
        const cn = cp.north + aN * off;
        const ce = cp.east + aE * off;
        arrow(g, cn - cp.dirN * 2.4, ce - cp.dirE * 2.4, cn + cp.dirN * 2.4, ce + cp.dirE * 2.4, ink, upper ? 0.16 : 0.22, upper ? '0.5 0.3' : '');
      }
      // On the approach side, where side-by-side gates leave room; the upper
      // gate of a stack on the exit side so the pair can be told apart.
      const sgn = upper ? 1 : -1;
      labels.push({ n: cp.north + cp.dirN * 3.3 * sgn, e: cp.east + cp.dirE * 3.3 * sgn, text: upper ? `${n}▲` : String(n), colour: labelCol, g });
    } else {
      const pink = '#d63c7c';
      el('circle', { cx: X(cp.east), cy: Y(cp.north), r: 0.42, fill: cp.invisible ? 'none' : pink, stroke: pink, 'stroke-width': 0.18 }, g);
      const w = 1.5;
      const pN = cp.north + aN * cp.side * w;
      const pE = cp.east + aE * cp.side * w;
      el('line', { x1: X(cp.east), y1: Y(cp.north), x2: X(pE), y2: Y(pN), stroke: pink, 'stroke-width': 0.08, 'stroke-dasharray': '0.25 0.2' }, g);
      arrow(g, pN - cp.dirN * 1.8, pE - cp.dirE * 1.8, pN + cp.dirN * 1.8, pE + cp.dirE * 1.8, pink, 0.2);
      labels.push({ n: cp.north - aN * cp.side * 1.3, e: cp.east - aE * cp.side * 1.3, text: String(n), colour: labelCol, g });
    }
  });
  const home = labels.map((l) => [l.n, l.e] as const);
  for (let it = 0; it < 60; it++) {
    for (let a = 0; a < labels.length; a++) {
      for (let b = a + 1; b < labels.length; b++) {
        const A = labels[a]!, B = labels[b]!;
        let dn = A.n - B.n, de = A.e - B.e;
        const d = Math.hypot(dn, de);
        const want = 1.9;
        if (d >= want) continue;
        if (d < 1e-6) { dn = 0; de = 1; } else { dn /= d; de /= d; }
        const push = (want - d) / 2;
        A.n += dn * push; A.e += de * push;
        B.n -= dn * push; B.e -= de * push;
      }
    }
  }
  labels.forEach((l, i) => {
    const [hn, he] = home[i]!;
    if (Math.hypot(l.n - hn, l.e - he) > 1.0) {
      el('line', { x1: X(he), y1: Y(hn), x2: X(l.e), y2: Y(l.n), stroke: l.colour, 'stroke-width': 0.05, 'stroke-opacity': 0.6 }, l.g);
    }
    el('text', { x: X(l.e), y: Y(l.n) + 0.45, 'font-size': 1.25, 'text-anchor': 'middle', fill: l.colour, 'font-weight': 700 }, l.g).textContent = l.text;
  });
  // Last, so the quad is drawn over the gates it flies through.
  drawPlayhead();
}

function describe(cp: Checkpoint): string {
  if (cp.kind === 'gate') {
    if (cp.dirU && Math.abs(cp.dirU) > 0.999) return cp.dirU < 0 ? 'dive, flown down' : 'opening, flown up';
    return `gate, flown towards ${headingOf(cp).toFixed(0)}°${cp.up > 2.4 ? ' (upper of a stack)' : ''}`;
  }
  return `${cp.invisible ? 'invisible pole' : 'flag'}, passed towards ${headingOf(cp).toFixed(0)}° with the pole on the ${cp.side > 0 ? 'left' : 'right'}`;
}

function set(n: number, ov: VdOverride | undefined): void {
  if (ov) overrides[n] = ov;
  else delete overrides[n];
  dirty = true;
  build();
}

function panel(): void {
  saveBtn.disabled = !dirty;
  revertBtn.disabled = !dirty;
  if (!imp || selected < 0) {
    selBox.innerHTML = '<p>Nothing selected.</p>';
    return;
  }
  const cp = imp.course.checkpoints[selected]!;
  const row = imp.table[selected]!;
  const n = row.gate;
  const ov = overrides[n];
  selBox.replaceChildren();
  const h = document.createElement('p');
  h.innerHTML = `<b style="color:var(--ink)">${n}</b> · ${row.prefab}<br>${describe(cp)}<br>${ov ? 'set by hand' : 'as the import chose it'}`;
  selBox.appendChild(h);
  const r = document.createElement('div');
  r.className = 'row';
  selBox.appendChild(r);
  const btn = (label: string, key: string, f: () => void): void => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = key ? `key: ${key}` : '';
    b.onclick = f;
    r.appendChild(b);
  };
  if (cp.kind === 'gate') {
    btn('Reverse', 'r', () => set(n, { ...ov, reverse: !ov?.reverse }));
  } else {
    const hd = headingOf(cp);
    const side: 'left' | 'right' = cp.side > 0 ? 'left' : 'right';
    const pin = (travel: number, s: 'left' | 'right'): void => set(n, { travel: ((travel % 360) + 360) % 360, side: s });
    btn('⟲ 22.5°', '[', () => pin(hd - 22.5, side));
    btn('⟳ 22.5°', ']', () => pin(hd + 22.5, side));
    btn('Reverse', 'r', () => pin(hd + 180, side === 'left' ? 'right' : 'left'));
    btn('Other side', 's', () => pin(hd, side === 'left' ? 'right' : 'left'));
  }
  if (ov) btn('Back to auto', 'a', () => set(n, undefined));
}

function table(): void {
  if (!imp) return;
  list.replaceChildren();
  imp.table.forEach((row, i) => {
    const tr = document.createElement('tr');
    if (overrides[row.gate]) tr.className = 'ov';
    if (i === selected) tr.style.background = 'color-mix(in srgb, var(--accent) 14%, transparent)';
    const cp = imp!.course.checkpoints[i]!;
    tr.innerHTML = `<td>${row.gate}</td><td>${row.kind}</td><td>${describe(cp).replace(/^[^,]*, /, '')}</td>`;
    tr.onclick = () => select(i);
    list.appendChild(tr);
  });
}

function select(i: number): void {
  selected = i;
  draw();
  panel();
  table();
}

// ---------------------------------------------------------------- interaction

let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
svg.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y, moved: false };
  svg.setPointerCapture(e.pointerId);
});
svg.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (Math.hypot(dx, dy) > 4) drag.moved = true;
  if (!drag.moved) return;
  const k = Math.max(vb.w / svg.clientWidth, vb.h / svg.clientHeight);
  vb.x = drag.vx - dx * k;
  vb.y = drag.vy - dy * k;
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
});
svg.addEventListener('pointerup', (e) => {
  const d = drag;
  drag = null;
  if (d?.moved) {
    draw();
    return;
  }
  svg.releasePointerCapture(e.pointerId);
  const hit = document.elementsFromPoint(e.clientX, e.clientY).map((x) => x.closest('[data-i]')).find((x) => x);
  select(hit ? Number(hit.getAttribute('data-i')) : -1);
});
svg.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const k = Math.max(vb.w / r.width, vb.h / r.height);
    // Map point under the cursor, honouring preserveAspectRatio's centring.
    const mx = vb.x + (e.clientX - r.left - (r.width - vb.w / k) / 2) * k;
    const my = vb.y + (e.clientY - r.top - (r.height - vb.h / k) / 2) * k;
    const f = Math.exp(e.deltaY * 0.0015);
    vb.x = mx - (mx - vb.x) * f;
    vb.y = my - (my - vb.y) * f;
    vb.w *= f;
    vb.h *= f;
    draw();
  },
  { passive: false },
);
document.addEventListener('keydown', (e) => {
  if (selected < 0 || e.target instanceof HTMLInputElement) return;
  const b = [...selBox.querySelectorAll('button')].find((x) => x.title === `key: ${e.key}`);
  if (b) b.click();
  else if (e.key === 'Escape') select(-1);
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const n = imp?.course.checkpoints.length ?? 1;
    select((selected + (e.key === 'ArrowRight' ? 1 : n - 1)) % n);
  }
});

saveBtn.onclick = async () => {
  if (!saved?.slug) return;
  status.textContent = 'Saving…';
  try {
    const r = await fetch('/__vd/overrides', { method: 'POST', body: JSON.stringify({ slug: saved.slug, overrides }) });
    if (!r.ok) throw new Error(await r.text());
    saved.overrides = structuredClone(overrides);
    dirty = false;
    status.textContent = `Saved to measurements/velocidrone/${saved.slug}/track.json`;
    panel();
  } catch (err) {
    status.textContent = `Not saved: ${String(err)}`;
  }
};
revertBtn.onclick = () => {
  overrides = structuredClone(saved?.overrides ?? {});
  dirty = false;
  build();
};
window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});

if (tracks.length === 0) {
  selBox.innerHTML = '<p>No imported tracks. Run <code>npm run vd:import -- &lt;name&gt;</code>, then reload.</p>';
} else {
  tracks.forEach((t, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = t.name;
    trackSel.appendChild(o);
  });
  trackSel.onchange = () => load(Number(trackSel.value));
  load(0);
}
