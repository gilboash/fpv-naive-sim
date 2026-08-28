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
  track: Track = TRACKS[1] ?? TRACKS[0]!;
  private sim: FlightSim;
  private statusEl: HTMLElement;

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

    const restart = el<HTMLButtonElement>('button');
    restart.type = 'button';
    restart.textContent = 'To start line';
    restart.onclick = () => this.placeAtStart();
    row.appendChild(restart);

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
    this.renderer?.loadTrack(track);
    this.placeAtStart();
  }

  /** Put the quad on the start line, disarmed and on the ground. */
  placeAtStart(): void {
    const s = this.track.start;
    this.sim.reset(s.yawDeg);
    this.sim.pos.x = s.north;
    this.sim.pos.y = s.east;
  }

  render(): void {
    if (!this.renderer) return;
    this.renderer.render(this.sim);
    this.statusEl.textContent = `${this.renderer.frameCostMs.toFixed(2)} ms/frame`;
  }
}
