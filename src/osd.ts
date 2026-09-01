/**
 * On-screen display, over the FPV view.
 *
 * It has to be on the video rather than beside it: a pilot racing is looking at
 * the picture, and in fullscreen the picture is all there is. A lap time in a
 * panel underneath might as well not exist.
 *
 * Plain DOM at 30 Hz. It is six short strings, and putting them through the GL
 * path would mean a texture atlas for no gain.
 */

import type { Race } from './race/race.ts';
import type { FlightSim } from './flight/sim.ts';
import { fmt } from './race-panel.ts';

const el = <T extends HTMLElement>(tag: string, cls?: string, text?: string): T => {
  const n = document.createElement(tag) as T;
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export class Osd {
  private clock: HTMLElement;
  private lap: HTMLElement;
  private next: HTMLElement;
  private last: HTMLElement;
  private countdown: HTMLElement;
  private armWarn: HTMLElement;
  private battery: HTMLElement;
  private alt: HTMLElement;
  private speed: HTMLElement;
  private summary: HTMLElement;
  /** When the race finished, so the summary can take itself away. */
  private finishedAt = 0;

  constructor(parent: HTMLElement) {
    const root = el('div', 'osd');

    const topLeft = el('div', 'osd-tl');
    this.clock = el('span', 'osd-clock', '');
    this.lap = el('span', 'osd-lap', '');
    this.next = el('span', 'osd-next', '');
    this.last = el('span', 'osd-last', '');
    topLeft.append(this.clock, this.lap, this.next, this.last);
    root.appendChild(topLeft);

    // Flight state, bottom-left, opposite the sticks.
    const botLeft = el('div', 'osd-bl');
    this.battery = el('span', 'osd-item', '');
    this.alt = el('span', 'osd-item', '');
    this.speed = el('span', 'osd-item', '');
    botLeft.append(this.battery, this.alt, this.speed);
    root.appendChild(botLeft);

    this.countdown = el('div', 'osd-count', '');
    root.appendChild(this.countdown);

    // Its own line rather than the centre slot, so it can sit under a running
    // countdown instead of replacing it.
    this.armWarn = el('div', 'osd-armwarn', '');
    root.appendChild(this.armWarn);

    // The result, on the video, for a few seconds after the last gate.
    //
    // The table under the scene has the splits and is the right place to study
    // a race; this is the right place to *finish* one. In fullscreen the panel
    // does not exist, and a pilot who has just crossed the line is still
    // looking at the picture — so hole shot, the laps, and the total, and
    // nothing per gate.
    this.summary = el('div', 'osd-summary', '');
    this.summary.style.display = 'none';
    root.appendChild(this.summary);

    parent.appendChild(root);
  }

  /** @param crashRecover seconds until an automatic respawn, or <0 for none. */
  render(race: Race, sim: FlightSim, crashRecover = -1): void {
    const t = sim.telemetry;
    this.battery.textContent = `${t.batteryV.toFixed(1)}V  ${t.batteryA.toFixed(0)}A`;
    this.alt.textContent = `${t.altitude.toFixed(1)} m`;
    this.speed.textContent = `${(t.speed * 3.6).toFixed(0)} km/h`;

    // Nothing about a race arms the quad, and a pilot who starts one disarmed
    // watches the clock run while the sticks do nothing — with no hint as to
    // why, because a disarmed quad on the ground looks exactly like an armed
    // one that is not being flown.
    const racing = race.state === 'countdown' || race.state === 'running';
    const warn = racing && !sim.armed && crashRecover < 0;
    this.armWarn.textContent = warn ? 'NOT ARMED — REMEMBER TO ARM' : '';
    this.armWarn.style.display = warn ? '' : 'none';

    if (crashRecover >= 0) {
      // Say what is about to happen, so a respawn is not mistaken for a glitch.
      this.countdown.textContent = 'CRASHED';
      this.countdown.className = 'osd-count crashed';
      this.countdown.style.display = '';
      return;
    }
    this.countdown.className = 'osd-count';

    if (race.state === 'countdown') {
      this.countdown.textContent = String(Math.ceil(race.countdown));
      this.countdown.style.display = '';
      this.clock.textContent = '';
      this.lap.textContent = '';
      this.next.textContent = '';
      this.last.textContent = '';
      return;
    }
    this.countdown.style.display = 'none';

    if (race.state === 'idle') {
      this.clock.textContent = '';
      this.lap.textContent = '';
      this.next.textContent = '';
      this.last.textContent = '';
      return;
    }

    this.clock.textContent = fmt(race.time);
    this.lap.textContent = `LAP ${Math.min(race.lap + 1, race.laps)}/${race.laps}`;

    const cp = race.activeCheckpoint;
    const total = race.course.checkpoints.length;
    // A cube opening is not "gate 4": the number would count checkpoints while
    // the blocks beside a gate count gates, and the two stopped agreeing when
    // the cubes went into the order. Say what the next thing actually is.
    const label =
      cp?.kind === 'flag'
        ? 'FLAG'
        : cp?.frame === 'none'
          ? cp.dirU
            ? `CUBE ${cp.dirU > 0 ? 'UP' : 'DOWN'}`
            : 'CUBE'
          : `GATE ${race.gateNumber(race.next)}`;
    this.next.textContent =
      race.state === 'finished' ? 'FINISHED' : `${label}  ${race.next + 1}/${total}`;

    const done = race.completed[race.completed.length - 1];
    this.last.textContent = done ? `LAST ${fmt(done.time)}${done.invalid ? ' ✗' : ''}` : '';

    this.renderSummary(race);
  }

  /** How long the finish summary stays up, seconds. */
  private static readonly SUMMARY_S = 9;

  private renderSummary(race: Race): void {
    if (race.state !== 'finished') {
      this.finishedAt = 0;
      this.summary.style.display = 'none';
      return;
    }
    const now = performance.now();
    if (this.finishedAt === 0) {
      this.finishedAt = now;
      const res = race.result();
      const rows = [`<div class="osd-sum-head">RACE COMPLETE</div>`];
      rows.push(`<div class="osd-sum-row"><span>HOLE SHOT</span><span>${fmt(res.holeShot)}</span></div>`);
      for (const lap of res.laps) {
        // A struck-out lap says why, here as well as in the table: the pilot
        // who most needs to know is the one who just finished the race.
        const why = lap.invalid ? ` <em>${lap.respawns} respawn${lap.respawns === 1 ? '' : 's'}</em>` : '';
        rows.push(
          `<div class="osd-sum-row${lap.invalid ? ' void' : ''}">` +
            `<span>LAP ${lap.number}${why}</span><span>${fmt(lap.time)}</span></div>`,
        );
      }
      if (res.best !== null) {
        rows.push(`<div class="osd-sum-row best"><span>BEST</span><span>${fmt(res.best)}</span></div>`);
      }
      if (res.bestThree !== null) {
        rows.push(`<div class="osd-sum-row"><span>BEST 3</span><span>${fmt(res.bestThree)}</span></div>`);
      }
      rows.push(`<div class="osd-sum-row total"><span>TOTAL</span><span>${fmt(res.total)}</span></div>`);
      // Built once, on the edge. Rebuilding this at 30 Hz would be a DOM churn
      // for a thing that cannot change once the race is over.
      this.summary.innerHTML = rows.join('');
    }
    this.summary.style.display = (now - this.finishedAt) / 1000 < Osd.SUMMARY_S ? '' : 'none';
  }
}
