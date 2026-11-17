/**
 * Draws a re-flown flight: the 3D view from a renderer of its own, with the
 * OSD and the sticks painted on top in 2D, into one canvas. The same canvas is
 * what the Replays tab shows and what the video encoder reads, so what you
 * watch is what you download.
 *
 * The OSD on the live view is HTML over the canvas (src/osd.ts); a video needs
 * it in the pixels, so it is drawn again here with the same text, colours and
 * rules. Sizes follow the live view's fullscreen ones, scaled to the frame.
 */

import { Renderer } from '../render/renderer.ts';
import type { Track } from '../render/track.ts';
import type { Obstacle } from '../flight/collision.ts';
import { fmt } from '../race-panel.ts';
import type { FlightTape, ReplayRun } from './tape.ts';
import type { StickInput } from '../flight/sim.ts';

/** How long the result card stays on after the finish, ticks. As on the live OSD. */
const SUMMARY_TICKS = 9000;

const STICKS: Record<1 | 2 | 3 | 4, { left: [keyof StickInput, keyof StickInput]; right: [keyof StickInput, keyof StickInput] }> = {
  1: { left: ['yaw', 'pitch'], right: ['roll', 'throttle'] },
  2: { left: ['yaw', 'throttle'], right: ['roll', 'pitch'] },
  3: { left: ['roll', 'pitch'], right: ['yaw', 'throttle'] },
  4: { left: ['roll', 'throttle'], right: ['yaw', 'pitch'] },
};

export class ReplayView {
  readonly width: number;
  readonly height: number;
  /** The finished frame: 3D view plus OSD. */
  readonly out: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private gl: HTMLCanvasElement;
  readonly renderer: Renderer;
  private loaded: unknown = null;
  private obstacles: Obstacle[] = [];

  constructor(width = 1280, height = 720) {
    this.width = width;
    this.height = height;
    this.gl = document.createElement('canvas');
    this.gl.width = width;
    this.gl.height = height;
    this.renderer = new Renderer(this.gl, { keepFrame: true });
    this.renderer.fixedSize = { w: width, h: height };
    this.out = document.createElement('canvas');
    this.out.width = width;
    this.out.height = height;
    const ctx = this.out.getContext('2d');
    if (!ctx) throw new Error('no 2D canvas');
    this.ctx = ctx;
  }

  /** Build the tape's map (once per map) and hand back its obstacles for the re-fly. */
  prepare(tape: FlightTape): Obstacle[] {
    if (this.loaded !== tape.track) {
      this.obstacles = this.renderer.loadTrack(tape.track as Track);
      this.loaded = tape.track;
    }
    this.renderer.camera.fovDeg = tape.view.fovDeg;
    this.renderer.camera.tiltDeg = tape.view.tiltDeg;
    this.renderer.motionBlur.shutterMs = tape.view.shutterMs;
    return this.obstacles;
  }

  /** Draw the state the run is in now. */
  draw(run: ReplayRun): void {
    const { sim, race } = run;
    this.renderer.setNextCheckpoint(race.state === 'running' ? race.activeCheckpoint : null);
    this.renderer.render(sim);
    const c = this.ctx;
    const W = this.width;
    const H = this.height;
    c.drawImage(this.gl, 0, 0, W, H);
    const u = H / 720;

    c.save();
    c.textBaseline = 'top';
    c.shadowColor = 'rgba(0,0,0,0.95)';
    c.shadowBlur = 4 * u;
    c.shadowOffsetY = 1 * u;
    const text = (s: string, x: number, y: number, size: number, color: string, weight = 700, align: CanvasTextAlign = 'left'): void => {
      c.font = `${weight} ${Math.round(size * u)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      c.fillStyle = color;
      c.textAlign = align;
      c.fillText(s, x, y);
    };

    // Flight state, bottom left.
    const t = sim.telemetry;
    const bl = [`${t.batteryV.toFixed(1)}V  ${t.batteryA.toFixed(0)}A`, `${t.altitude.toFixed(1)} m`, `${(t.speed * 3.6).toFixed(0)} km/h`];
    bl.forEach((s, i) => text(s, 22 * u, H - (22 + (bl.length - i) * 24) * u, 19, '#dbe3ee', 600));

    text('NacoSim', W - 22 * u, 18 * u, 21, 'rgba(255,255,255,0.82)', 800, 'right');

    const racing = race.state === 'countdown' || race.state === 'running';
    const crashedInRace = race.state === 'running' && sim.crashed;
    if (racing && !sim.armed && !crashedInRace) {
      text('NOT ARMED — REMEMBER TO ARM', W / 2, H * 0.58, 32, '#ffca3a', 800, 'center');
    }

    c.textBaseline = 'middle';
    if (crashedInRace) text('YOU SUCK', W / 2, H / 2, 60, '#ff6b6b', 800, 'center');
    else if (race.state === 'countdown') text(String(Math.ceil(race.countdown)), W / 2, H / 2, 140, '#fff', 800, 'center');
    c.textBaseline = 'top';

    if (race.state === 'running' || race.state === 'finished') {
      let y = 18 * u;
      text(fmt(race.time), 22 * u, y, 46, '#fff', 700);
      y += 50 * u;
      text(`LAP ${Math.min(race.lap + 1, race.laps)}/${race.laps}`, 22 * u, y, 20, '#f4b400', 700);
      y += 25 * u;
      const cp = race.activeCheckpoint;
      const total = race.course.checkpoints.length;
      const label =
        cp?.kind === 'flag'
          ? 'FLAG'
          : cp?.frame === 'none'
            ? cp.dirU
              ? `CUBE ${cp.dirU > 0 ? 'UP' : 'DOWN'}`
              : 'CUBE'
            : `GATE ${race.gateNumber(race.next)}`;
      text(race.state === 'finished' ? 'FINISHED' : `${label}  ${race.next + 1}/${total}`, 22 * u, y, 18, '#35e07a', 700);
      y += 23 * u;
      const done = race.completed[race.completed.length - 1];
      if (done) text(`LAST ${fmt(done.time)}${done.invalid ? ' ✗' : ''}`, 22 * u, y, 17, '#dbe3ee', 500);
    }

    if (race.state === 'finished' && run.finishedTick >= 0 && run.tick - run.finishedTick < SUMMARY_TICKS) this.summary(run, u);
    c.restore();

    this.sticks(run.input, run.tape.view.stickMode, u);
  }

  private summary(run: ReplayRun, u: number): void {
    const c = this.ctx;
    const res = run.race.result();
    const rows: [string, string, string][] = [['HOLE SHOT', fmt(res.holeShot), '#f2f6fb']];
    for (const lap of res.laps) {
      const why = lap.invalid ? `  ${lap.respawns} respawn${lap.respawns === 1 ? '' : 's'}` : '';
      rows.push([`LAP ${lap.number}${why}`, fmt(lap.time), lap.invalid ? '#96a1b0' : '#f2f6fb']);
    }
    if (res.best !== null) rows.push(['BEST', fmt(res.best), '#56d67f']);
    if (res.bestThree !== null) rows.push(['BEST 3', fmt(res.bestThree), '#f2f6fb']);
    rows.push(['TOTAL', fmt(res.total), '#ffd24a']);
    const lh = 30 * u;
    const w = 380 * u;
    const h = (rows.length + 1) * lh + 34 * u;
    const x = (this.width - w) / 2;
    const y = (this.height - h) / 2;
    c.shadowBlur = 0;
    c.fillStyle = 'rgba(8, 11, 14, 0.72)';
    c.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    c.lineWidth = 1.5 * u;
    c.beginPath();
    c.roundRect(x, y, w, h, 10 * u);
    c.fill();
    c.stroke();
    c.shadowBlur = 4 * u;
    c.font = `600 ${Math.round(17 * u)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    c.textAlign = 'center';
    c.fillStyle = '#ffd24a';
    c.fillText('RACE COMPLETE', x + w / 2, y + 16 * u);
    rows.forEach(([l, r, color], i) => {
      const ry = y + 16 * u + (i + 1) * lh + 4 * u;
      c.fillStyle = color;
      c.textAlign = 'left';
      c.fillText(l, x + 24 * u, ry);
      c.textAlign = 'right';
      c.fillText(r, x + w - 24 * u, ry);
    });
  }

  /** The two gimbals, bottom right, as on the live view. */
  private sticks(input: StickInput, mode: 1 | 2 | 3 | 4, u: number): void {
    const c = this.ctx;
    const layout = STICKS[mode] ?? STICKS[2];
    const size = 92 * u;
    const gap = 20 * u;
    const y0 = this.height - 22 * u - size;
    const x0 = this.width - 22 * u - size * 2 - gap;
    const clamp = (v: number): number => Math.max(-1, Math.min(1, v));
    [layout.left, layout.right].forEach(([hk, vk], i) => {
      const x = x0 + i * (size + gap);
      c.fillStyle = 'rgba(13, 17, 23, 0.55)';
      c.strokeStyle = 'rgba(219, 227, 238, 0.35)';
      c.lineWidth = 1.5 * u;
      c.beginPath();
      c.roundRect(x, y0, size, size, 12 * u);
      c.fill();
      c.stroke();
      c.strokeStyle = 'rgba(219, 227, 238, 0.22)';
      c.beginPath();
      c.moveTo(x, y0 + size / 2);
      c.lineTo(x + size, y0 + size / 2);
      c.moveTo(x + size / 2, y0);
      c.lineTo(x + size / 2, y0 + size);
      c.stroke();
      const hv = clamp(input[hk]);
      const raw = input[vk];
      const vv = clamp(vk === 'throttle' ? raw * 2 - 1 : raw);
      const r = (size / 2) * (20 / 24);
      c.fillStyle = '#f4b400';
      c.strokeStyle = 'rgba(13, 17, 23, 0.8)';
      c.beginPath();
      c.arc(x + size / 2 + hv * r, y0 + size / 2 - vv * r, 8.5 * u, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    });
  }
}
