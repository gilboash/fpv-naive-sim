/**
 * The FPV view and its controls.
 *
 * Owns the canvas and the renderer, and nothing else. It reads simulator state
 * and never writes it, except when loading a track, which has to place the
 * quad at the start line.
 */

import type { FlightSim } from './flight/sim.ts';
import { Renderer } from './render/renderer.ts';
import { TRACKS, type Track } from './render/track.ts';
import { clearance } from './flight/collision.ts';

const el = <T extends HTMLElement>(tag: string, cls?: string, text?: string): T => {
  const n = document.createElement(tag) as T;
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export class SceneView {
  readonly canvas: HTMLCanvasElement;
  renderer: Renderer | null = null;
  private failure = '';
  track: Track = TRACKS[2] ?? TRACKS[0]!;
  private sim: FlightSim;
  private statusEl: HTMLElement;
  private crashEl: HTMLElement;
  resetMode: 'inPlace' | 'start' = 'inPlace';

  constructor(root: HTMLElement, sim: FlightSim) {
    this.sim = sim;
    this.canvas = el<HTMLCanvasElement>('canvas', 'fpv-canvas');
    root.appendChild(this.canvas);

    const row = el('div', 'row');

    const trackSel = el<HTMLSelectElement>('select');
    TRACKS.forEach((t, i) => {
      const o = el<HTMLOptionElement>('option');
      o.value = String(i);
      o.textContent = t.name;
      trackSel.appendChild(o);
    });
    trackSel.value = String(Math.max(0, TRACKS.indexOf(this.track)));
    trackSel.onchange = () => this.loadTrack(TRACKS[Number(trackSel.value)] ?? TRACKS[0]!);
    const trackLabel = el('label', undefined, 'Map ');
    trackLabel.appendChild(trackSel);
    row.appendChild(trackLabel);

    const num = (
      label: string,
      value: number,
      min: number,
      max: number,
      onChange: (v: number) => void,
    ): void => {
      const wrap = el('label', undefined, `${label} `);
      const input = el<HTMLInputElement>('input');
      input.type = 'number';
      input.min = String(min);
      input.max = String(max);
      input.value = String(value);
      input.step = '5';
      input.oninput = () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
      };
      wrap.appendChild(input);
      wrap.appendChild(document.createTextNode('°'));
      row.appendChild(wrap);
    };
    num('FOV', 75, 50, 130, (v) => {
      if (this.renderer) this.renderer.camera.fovDeg = v;
    });
    num('Cam tilt', 25, 0, 60, (v) => {
      if (this.renderer) this.renderer.camera.tiltDeg = v;
    });

    // Where a reset puts you. In place by default: sending a pilot back to the
    // start after every crash spends their session on the walk rather than on
    // the thing they were practising.
    const modeSel = el<HTMLSelectElement>('select');
    for (const [v, label] of [
      ['inPlace', 'where you crashed'],
      ['start', 'start line'],
    ] as const) {
      const o = el<HTMLOptionElement>('option');
      o.value = v;
      o.textContent = label;
      modeSel.appendChild(o);
    }
    modeSel.onchange = () => {
      this.resetMode = modeSel.value === 'start' ? 'start' : 'inPlace';
    };
    const ml = el('label', undefined, 'Reset to ');
    ml.appendChild(modeSel);
    row.appendChild(ml);

    const restart = el<HTMLButtonElement>('button');
    restart.type = 'button';
    restart.textContent = 'To start line';
    restart.onclick = () => this.placeAtStart();
    row.appendChild(restart);

    this.crashEl = el('span', 'crash-flag', '');
    row.appendChild(this.crashEl);

    this.statusEl = el('span', 'dim', '');
    row.appendChild(this.statusEl);
    root.appendChild(row);

    try {
      this.renderer = new Renderer(this.canvas);
      this.loadTrack(this.track);
    } catch (e) {
      this.failure = e instanceof Error ? e.message : String(e);
      this.canvas.style.display = 'none';
      const warn = el(
        'p',
        'hint',
        `No 3D view: ${this.failure}. The flight model and the instruments below are unaffected.`,
      );
      root.appendChild(warn);
    }
  }

  get available(): boolean {
    return this.renderer !== null;
  }

  loadTrack(track: Track): void {
    this.track = track;
    // The collision volumes come back from the same build that made the mesh,
    // so the quad hits what it can see.
    const obstacles = this.renderer?.loadTrack(track);
    if (obstacles) this.sim.obstacles = obstacles;
    this.placeAtStart();
  }

  /** Whatever the current reset mode says. */
  reset(): void {
    if (this.resetMode === 'start') this.placeAtStart();
    else this.respawnInPlace();
  }

  /** Put the quad on the start line, disarmed and on the ground. */
  placeAtStart(): void {
    const s = this.track.start;
    this.sim.reset(s.yawDeg);
    this.sim.pos.x = s.north;
    this.sim.pos.y = s.east;
  }

  /**
   * Put it back where it went in, level and stationary, standing on the ground
   * and pushed clear of whatever it hit — respawning inside the pole you just
   * clipped is an instant second crash and reads as broken.
   *
   * On the ground, not hovering. Handing the quad back in mid-air looks
   * friendlier and is a trap: with the throttle down, as it must be to re-arm,
   * a metre and a half of free fall arrives at 5.2 m/s and crashes it again
   * within 600 ms. The pilot presses reset, watches it drop, and cannot fly.
   *
   * Heading comes from the moment of the crash rather than from the wreck,
   * because a tumbled quad ends up pointing anywhere and the pilot wants to be
   * facing back down the line they were flying.
   */
  respawnInPlace(): void {
    const yaw = this.sim.crashed ? this.sim.yawAtCrash : this.sim.telemetry.attitude.yaw;
    const spot = clearance(this.sim.obstacles, this.sim.pos.x, this.sim.pos.y, 0.5, 1.2);
    this.sim.reset(yaw);
    this.sim.pos.x = spot.north;
    this.sim.pos.y = spot.east;
  }

  render(): void {
    if (!this.renderer) return;
    this.renderer.render(this.sim);
    this.statusEl.textContent = `${this.renderer.frameCostMs.toFixed(2)} ms/frame`;
    this.crashEl.textContent = this.sim.crashed
      ? `crashed at ${this.sim.crashSpeed.toFixed(1)} m/s — press R to go again`
      : '';
  }
}
