/**
 * The FPV view and its controls.
 *
 * Owns the canvas and the renderer, and nothing else. It reads simulator state
 * and never writes it, except when loading a track, which has to place the
 * quad at the start line.
 */

import type { FlightSim } from './flight/sim.ts';
import { Renderer } from './render/renderer.ts';
import { raceField, type Track } from './render/track.ts';
import { clearance } from './flight/collision.ts';
import { StickView } from './stick-view.ts';
import type { Checkpoint } from './race/course.ts';
import { Osd } from './osd.ts';
import type { Commands, StickMode } from './mapping.ts';

/**
 * Maps that changed name, so a pilot's stored choice survives the rename.
 *
 * Storing by name rather than by index is what makes this a two-line table
 * instead of a silent repointing: an index is not an identifier, and this file
 * has been bitten by that twice.
 */
const RENAMED: Record<string, string> = {
  'Race — six gates': 'Race vibes',
  Circuit: 'Freestyle',
};

const STORAGE_KEY = 'fpvsim.scene.v1';

interface StoredScene {
  version: 1;
  fovDeg: number;
  tiltDeg: number;
  /**
   * Stored by NAME, not by index.
   *
   * It was an index, and adding the race map at position 0 silently repointed
   * every saved setting at a different map — someone who had chosen the loop
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
  /** The row of view settings under the picture: map, FOV, tilt, reset mode. */
  readonly controls: HTMLElement;

  /**
   * Put a control in with the view's settings.
   *
   * Ahead of the crash flag and the frame-time readout, which are status rather
   * than settings: appending to the end of the row put the sound button after
   * "0.07 ms/frame" and wrapped it onto a line of its own.
   */
  addControl(node: HTMLElement): void {
    this.controlSlot.appendChild(node);
  }
  renderer: Renderer | null = null;
  private failure = '';
  /**
   * The race course, by reference rather than by position.
   *
   * This line said `TRACKS[2]`, which meant the circuit when it was written and
   * silently became the gate run when the race map went in at the front — the
   * same index-is-not-an-identifier bug that had already been fixed for the
   * *stored* map without anyone noticing it applied here too. Naming the track
   * cannot rot that way.
   */
  track: Track = raceField;
  private sim: FlightSim;
  private statusEl: HTMLElement;
  private crashEl: HTMLElement;
  private trackSel: HTMLSelectElement;

  /**
   * Where the list of maps comes from. Set by the owner so that the pilot's own
   * tracks join the built-in ones — SceneView draws a track, and has no opinion
   * about where the list came from.
   */
  tracks: () => Track[] = () => [raceField];

  /**
   * Rebuild the selector. Called when a pilot saves or deletes a track of their
   * own, since the list is theirs and changes while the page is open.
   */
  fillTracks(): void {
    const sel = this.trackSel;
    sel.innerHTML = '';
    for (const t of this.tracks()) {
      const o = el<HTMLOptionElement>('option');
      o.value = t.name;
      o.textContent = t.name;
      sel.appendChild(o);
    }
    // A track can be deleted while it is loaded; fall back rather than leave
    // the selector showing a map that is no longer there.
    if (!this.tracks().some((t) => t.name === this.track.name)) this.loadTrack(this.tracks()[0] ?? raceField);
    sel.value = this.track.name;
  }
  private controlSlot: HTMLElement;
  readonly stage: HTMLElement;
  readonly sticks: StickView;
  readonly osd: Osd;
  private modeSel!: HTMLSelectElement;
  private restartBtn!: HTMLButtonElement;
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
    this.trackSel = trackSel;
    this.fillTracks();
    // Selected by *name*. The option values are names too, for the same reason
    // the stored setting is: inserting a map at the front once silently
    // repointed everyone's saved choice at a different track.
    trackSel.onchange = () => {
      const chosen = this.tracks().find((t) => t.name === trackSel.value);
      if (chosen) this.loadTrack(chosen);
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
    this.modeSel = modeSel;
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
    this.restartBtn = restart;
    row.appendChild(restart);

    this.crashEl = el('span', 'crash-flag', '');
    // Anything added by the owner goes here: with the controls, and ahead of
    // the crash and frame-time readouts, which are status rather than settings
    // and belong at the end of the row.
    this.controlSlot = el('span', 'control-slot');
    row.appendChild(this.controlSlot);

    row.appendChild(this.crashEl);

    this.statusEl = el('span', 'dim', '');
    row.appendChild(this.statusEl);
    root.appendChild(row);
    // Exposed so anything else that belongs with the view's settings can join
    // them rather than starting a second row of controls above the picture.
    this.controls = row;

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
      const wanted = st.trackName ? RENAMED[st.trackName] ?? st.trackName : undefined;
      const byName = wanted ? this.tracks().find((t) => t.name === wanted) : undefined;
      if (byName) this.track = byName;
      else if (typeof st.track === 'number') {
        // One-time migration from the index era. The order at the time was
        // [openField, gateRun, circuit]; the race map went in front of it.
        const legacy = ['Open field', 'Gate run', 'Circuit'][st.track];
        const t = legacy ? this.tracks().find((x) => x.name === (RENAMED[legacy] ?? legacy)) : undefined;
        if (t) this.track = t;
      }
      // A name that is neither current nor renamed is a map that no longer
      // exists — Open field and Gate run went when the race maps arrived. The
      // default stands, which is why this is not an error.
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

  /**
   * Set while a race is running, so a crash puts the quad back where it went in
   * whatever the selector says.
   *
   * Sending a racer to the start line mid-race ends the race in practice — the
   * remaining checkpoints are behind them and the lap is already void, so there
   * is nothing to do but abort. Respawning in place lets them carry on and
   * finish, which is what a pilot practising a track wants. Outside a race the
   * selector is honoured, because there "put me back at the start" is a
   * perfectly reasonable thing to ask for.
   */
  forceInPlace = false;

  /**
   * While a race is on, the reset controls are off.
   *
   * Not because they would break anything, but because neither means anything:
   * the respawn mode is forced in place for the duration, and "to start line"
   * would put the pilot behind every remaining checkpoint with the clock still
   * running. A control that is live but inert is a small lie.
   */
  setRacing(racing: boolean): void {
    if (this.modeSel.disabled === racing) return;
    this.modeSel.disabled = racing;
    this.restartBtn.disabled = racing;
    this.modeSel.title = racing ? 'Fixed to “where you crashed” during a race.' : '';
    this.restartBtn.title = racing ? 'Not while a race is running — abort it first.' : '';
  }

  /** Whatever the current reset mode says, unless a race overrides it. */
  reset(): void {
    if (this.resetMode === 'start' && !this.forceInPlace) this.placeAtStart();
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
  /**
   * Fullscreen, three ways, because the phone a pilot is holding decides which
   * of them exists.
   *
   * Safari on iPhone has **no element fullscreen at all** — only `<video>` can
   * go fullscreen there — so the unprefixed call threw and the button looked
   * dead. Older WebKit wants the `webkit` prefix. Where neither is on offer the
   * stage is pinned to the viewport with CSS instead: the browser chrome stays,
   * which is the part that cannot be helped, but the picture fills the screen,
   * which is the part that matters.
   */
  get isFullscreen(): boolean {
    const d = document as Document & { webkitFullscreenElement?: Element };
    return (
      d.fullscreenElement === this.stage ||
      d.webkitFullscreenElement === this.stage ||
      this.stage.classList.contains('pseudo-fullscreen')
    );
  }

  /** Which mechanism this browser will actually use. Read by the checks. */
  get fullscreenKind(): 'native' | 'webkit' | 'css' {
    const e = this.stage as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
    if (typeof e.requestFullscreen === 'function') return 'native';
    if (typeof e.webkitRequestFullscreen === 'function') return 'webkit';
    return 'css';
  }

  async toggleFullscreen(): Promise<void> {
    const d = document as Document & {
      webkitFullscreenElement?: Element;
      webkitExitFullscreen?: () => Promise<void>;
    };
    const e = this.stage as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };

    if (this.isFullscreen) {
      if (this.stage.classList.contains('pseudo-fullscreen')) this.setPseudoFullscreen(false);
      else if (d.fullscreenElement) await d.exitFullscreen();
      else if (d.webkitFullscreenElement) await d.webkitExitFullscreen?.();
      return;
    }

    try {
      if (this.fullscreenKind === 'native') await this.stage.requestFullscreen();
      else if (this.fullscreenKind === 'webkit') await e.webkitRequestFullscreen?.();
      else this.setPseudoFullscreen(true);
    } catch {
      // A refusal is as good as an absence — some browsers have the method and
      // decline to use it. Either way the pilot asked for a bigger picture.
      this.setPseudoFullscreen(true);
    }

    // Landscape, where the browser allows it. A phone held in portrait is
    // nearly useless for this, and asking is free. iOS does not offer it.
    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (o: string) => Promise<void>;
    };
    try {
      await orientation.lock?.('landscape');
    } catch {
      /* not supported, or the user has rotation locked. Not worth a word. */
    }
  }

  /**
   * The CSS fallback: pin the stage over the page.
   *
   * It needs its own way out, because there is no Escape key on a phone and the
   * button that got you here is now underneath the picture.
   */
  private setPseudoFullscreen(on: boolean): void {
    this.stage.classList.toggle('pseudo-fullscreen', on);
    document.body.classList.toggle('fullscreen-locked', on);
    if (on && !this.exitBtn) {
      const btn = el<HTMLButtonElement>('button', 'fpv-exit');
      btn.type = 'button';
      btn.textContent = '✕';
      btn.title = 'Leave fullscreen';
      btn.onclick = () => this.setPseudoFullscreen(false);
      this.stage.appendChild(btn);
      this.exitBtn = btn;
    }
    if (this.exitBtn) this.exitBtn.style.display = on ? '' : 'none';
    // The canvas is sized from its box, so it has to be told the box changed.
    this.renderer?.render(this.sim);
  }

  private exitBtn: HTMLButtonElement | null = null;

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
