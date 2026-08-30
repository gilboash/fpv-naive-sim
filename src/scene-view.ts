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
import { StickView } from './stick-view.ts';
import type { Checkpoint } from './race/course.ts';
import { Osd } from './osd.ts';
import type { Commands, StickMode } from './mapping.ts';

const STORAGE_KEY = 'fpvsim.scene.v1';

interface StoredScene {
  version: 1;
  fovDeg: number;
  tiltDeg: number;
  /**
   * Stored by NAME, not by index.
   *
   * It was an index, and adding the race map at position 0 silently repointed
   * every saved setting at a different map — someone who had chosen the circuit
   * came back to the gate run. An index is not an identifier; it is a fact
   * about the current order of a list.
   */
  trackName?: string;
  /** Legacy index, read once and migrated. */
  track?: number;
  resetMode: 'inPlace' | 'start';
}

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
  readonly stage: HTMLElement;
  readonly sticks: StickView;
  readonly osd: Osd;
  resetMode: 'inPlace' | 'start' = 'inPlace';
  /**
   * Camera settings live here as well as on the renderer, because the controls
   * are built before the renderer exists and because they have to survive a
   * reload. Camera tilt especially: pilots have firm preferences about it, and
   * re-entering a personal number on every visit is the kind of friction that
   * gets a tool abandoned rather than reported.
   */
  private fovDeg = 75;
  private tiltDeg = 25;

  constructor(root: HTMLElement, sim: FlightSim) {
    this.sim = sim;
    this.loadSettings();
    // The canvas and its overlays share a positioned wrapper, which is also
    // what goes fullscreen — the sticks belong on the view, not beside it.
    this.stage = el('div', 'fpv-stage');
    this.canvas = el<HTMLCanvasElement>('canvas', 'fpv-canvas');
    this.stage.appendChild(this.canvas);
    // The OSD goes on the stage, so it survives fullscreen along with the view.
    this.osd = new Osd(this.stage);
    const overlay = el('div', 'fpv-overlay');
    this.sticks = new StickView(overlay);
    this.stage.appendChild(overlay);
    root.appendChild(this.stage);

    const row = el('div', 'row');

    const trackSel = el<HTMLSelectElement>('select');
    TRACKS.forEach((t, i) => {
      const o = el<HTMLOptionElement>('option');
      o.value = String(i);
      o.textContent = t.name;
      trackSel.appendChild(o);
    });
    trackSel.value = String(Math.max(0, TRACKS.indexOf(this.track)));
    trackSel.onchange = () => {
      this.loadTrack(TRACKS[Number(trackSel.value)] ?? TRACKS[0]!);
      this.saveSettings();
    };
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
    num('FOV', this.fovDeg, 50, 130, (v) => {
      this.fovDeg = v;
      if (this.renderer) this.renderer.camera.fovDeg = v;
      this.saveSettings();
    });
    num('Cam tilt', this.tiltDeg, 0, 60, (v) => {
      this.tiltDeg = v;
      if (this.renderer) this.renderer.camera.tiltDeg = v;
      this.saveSettings();
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
    modeSel.value = this.resetMode;
    modeSel.onchange = () => {
      this.resetMode = modeSel.value === 'start' ? 'start' : 'inPlace';
      this.saveSettings();
    };
    const ml = el('label', undefined, 'Reset to ');
    ml.appendChild(modeSel);
    row.appendChild(ml);

    const full = el<HTMLButtonElement>('button');
    full.type = 'button';
    full.textContent = 'Fullscreen';
    full.onclick = () => void this.toggleFullscreen();
    row.appendChild(full);

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
      // The renderer is built after the controls, so the stored camera has to
      // be pushed into it here rather than by the control callbacks.
      this.renderer.camera.fovDeg = this.fovDeg;
      this.renderer.camera.tiltDeg = this.tiltDeg;
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

  private loadSettings(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const st = JSON.parse(raw) as StoredScene;
      if (st.version !== 1) return;
      if (Number.isFinite(st.fovDeg)) this.fovDeg = Math.max(50, Math.min(130, st.fovDeg));
      if (Number.isFinite(st.tiltDeg)) this.tiltDeg = Math.max(0, Math.min(60, st.tiltDeg));
      if (st.resetMode === 'start' || st.resetMode === 'inPlace') this.resetMode = st.resetMode;
      const byName = st.trackName ? TRACKS.find((t) => t.name === st.trackName) : undefined;
      if (byName) this.track = byName;
      else if (typeof st.track === 'number') {
        // One-time migration from the index era. The order at the time was
        // [openField, gateRun, circuit]; the race map went in front of it.
        const legacy = ['Open field', 'Gate run', 'Circuit'][st.track];
        const t = TRACKS.find((x) => x.name === legacy);
        if (t) this.track = t;
      }
    } catch {
      // A corrupt stored setting should cost the defaults, not the page.
    }
  }

  private saveSettings(): void {
    try {
      const st: StoredScene = {
        version: 1,
        fovDeg: this.fovDeg,
        tiltDeg: this.tiltDeg,
        trackName: this.track.name,
        resetMode: this.resetMode,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
    } catch {
      /* private mode, quota — not worth failing over */
    }
  }

  get available(): boolean {
    return this.renderer !== null;
  }

  /** Fired when the loaded map changes, so the race can follow it. */
  onTrackChange: ((track: Track) => void) | null = null;

  loadTrack(track: Track): void {
    this.track = track;
    // The collision volumes come back from the same build that made the mesh,
    // so the quad hits what it can see.
    const obstacles = this.renderer?.loadTrack(track);
    if (obstacles) this.sim.obstacles = obstacles;
    this.renderer?.setNextCheckpoint(null);
    this.placeAtStart();
    this.onTrackChange?.(track);
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

  /** Stick positions, from the 30 Hz loop. Cheap, and not in the render path. */
  updateSticks(cmd: Commands, mode: StickMode): void {
    this.sticks.setMode(mode);
    this.sticks.update(cmd);
  }

  /** Go fullscreen on the view itself, sticks included. */
  async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await this.stage.requestFullscreen();
  }

  /** Outline the next checkpoint, or clear it with null. */
  setNextCheckpoint(cp: Checkpoint | null): void {
    this.renderer?.setNextCheckpoint(cp);
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
