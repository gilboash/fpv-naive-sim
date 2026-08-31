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
    this.next.textContent =
      race.state === 'finished'
        ? 'FINISHED'
        : `${cp?.kind === 'flag' ? 'FLAG' : `GATE ${race.next + 1}`}  ${race.next + 1}/${total}`;

    const done = race.completed[race.completed.length - 1];
    this.last.textContent = done ? `LAST ${fmt(done.time)}${done.invalid ? ' ✗' : ''}` : '';
  }
}
