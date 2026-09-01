/**
 * Race controls and results.
 *
 * Lives on the flying tab, because it is entirely a live-flight concern. The
 * timing itself runs in the 1 kHz tick (see race/race.ts); this only reads it.
 */

import type { FlightSim } from './flight/sim.ts';
import { Race } from './race/race.ts';
import { sixGateCourse, type Course } from './race/course.ts';

const el = <T extends HTMLElement>(tag: string, cls?: string, text?: string): T => {
  const n = document.createElement(tag) as T;
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** m:ss.hh, which is how a lap time is read. */
export function fmt(t: number): string {
  if (!Number.isFinite(t)) return '—';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m > 0 ? `${m}:${s.toFixed(2).padStart(5, '0')}` : s.toFixed(2);
}

export class RacePanel {
  readonly race = new Race(sixGateCourse);
  private sim: FlightSim;
  /**
   * Which map is loaded, so a race is never run against gates that are not
   * standing there. Set by the owner whenever the track changes.
   */
  private courseAvailable = false;
  private startBtn: HTMLButtonElement;
  private lapsInput: HTMLInputElement;
  private live: HTMLElement;
  private results: HTMLElement;
  /** Set by the owner: puts the quad on the start line. */
  onArmAtStart: (() => void) | null = null;

  constructor(root: HTMLElement, sim: FlightSim) {
    this.sim = sim;

    const row = el('div', 'row');
    this.startBtn = el<HTMLButtonElement>('button');
    this.startBtn.type = 'button';
    this.startBtn.textContent = 'Start race';
    this.startBtn.onclick = () => this.toggle();
    row.appendChild(this.startBtn);

    const lapWrap = el('label', undefined, 'Laps ');
    this.lapsInput = el<HTMLInputElement>('input');
    this.lapsInput.type = 'number';
    this.lapsInput.min = '1';
    this.lapsInput.max = '20';
    this.lapsInput.value = String(sixGateCourse.defaultLaps);
    this.lapsInput.oninput = () => {
      const v = Number(this.lapsInput.value);
      if (Number.isFinite(v) && v >= 1) this.race.laps = Math.round(v);
    };
    lapWrap.appendChild(this.lapsInput);
    row.appendChild(lapWrap);

    this.live = el('span', 'race-live');
    row.appendChild(this.live);
    row.appendChild(this.hint);
    root.appendChild(row);

    this.results = el('div', 'race-results');
    root.appendChild(this.results);
  }

  /**
   * Tell the panel which course the loaded map carries, if any.
   *
   * This exists because of a real and thoroughly confusing bug: the race ran
   * against its own hard-coded course whatever map was loaded, so starting one
   * on the freestyle map drew checkpoint markers hanging in mid-air where that
   * course's gates would have been — pointing at gates that were not there.
   * A race belongs to a map.
   */
  setCourse(course: Course | null): void {
    this.courseAvailable = course !== null;
    if (course && course !== this.race.course) {
      const laps = this.race.laps;
      this.race.reset();
      this.race.course = course;
      this.race.laps = laps;
      this.results.innerHTML = '';
    }
    if (!course && this.race.state !== 'idle') this.race.reset();
    this.startBtn.disabled = !this.courseAvailable;
    this.startBtn.title = this.courseAvailable
      ? ''
      : 'This map has no course. Pick a race map to time a lap.';
    this.hint.textContent = this.courseAvailable
      ? ''
      : 'No course on this map — pick a race map to race.';
  }

  private hint = el('span', 'dim', '');

  /** For the browser check: is starting a race currently possible? */
  get startBtnDisabled(): boolean {
    return this.startBtn.disabled;
  }

  private toggle(): void {
    if (!this.courseAvailable) return;
    if (this.race.state === 'countdown' || this.race.state === 'running') {
      this.race.reset();
      this.startBtn.textContent = 'Start race';
      this.results.innerHTML = '';
      return;
    }
    this.results.innerHTML = '';
    this.onArmAtStart?.();
    this.race.start(3);
    this.startBtn.textContent = 'Abort';
  }

  /** From the 30 Hz loop. */
  render(): void {
    const r = this.race;
    const total = r.course.checkpoints.length;

    if (r.state === 'countdown') {
      this.live.textContent = `starting in ${Math.ceil(r.countdown)}…`;
      this.live.className = 'race-live count';
      return;
    }
    if (r.state === 'running') {
      const cp = r.activeCheckpoint;
      const what = cp?.kind === 'flag' ? 'flag' : `gate ${r.next + 1}`;
      this.live.textContent =
        `${fmt(r.time)}  ·  lap ${r.lap + 1}/${r.laps}  ·  next: ${what} (${r.next + 1}/${total})`;
      this.live.className = 'race-live running';
      return;
    }
    if (r.state === 'finished') {
      if (!this.results.childElementCount) this.showResults();
      this.live.textContent = 'finished';
      this.live.className = 'race-live done';
      this.startBtn.textContent = 'Start race';
      return;
    }
    this.live.textContent = '';
    this.live.className = 'race-live';
  }

  private showResults(): void {
    const res = this.race.result();
    const host = this.results;
    host.innerHTML = '';

    const head = el('div', 'race-summary');
    for (const [label, value] of [
      ['hole shot', fmt(res.holeShot)],
      ['best lap', res.best === null ? '—' : fmt(res.best)],
      ['best 3 consecutive', res.bestThree === null ? '—' : fmt(res.bestThree)],
      ['total', fmt(res.total)],
    ] as [string, string][]) {
      const cell = el('div', 'fl-num');
      cell.appendChild(el('span', 'fl-num-label', label));
      cell.appendChild(el('span', 'fl-num-val', value));
      head.appendChild(cell);
    }
    host.appendChild(head);

    // Splits: every gate-to-gate segment, which is where a lap is actually won
    // or lost. A total tells a pilot they were slow; this tells them where.
    const table = el('table', 'race-table');
    const names = this.race.course.checkpoints.map((cp, i) =>
      cp.kind === 'flag' ? 'flag' : cp.frame === 'none' ? 'cube' : `g${this.race.gateNumber(i)}`,
    );
    const hdr = el('tr');
    hdr.appendChild(el('th', undefined, 'lap'));
    for (const n of names) hdr.appendChild(el('th', undefined, n));
    hdr.appendChild(el('th', undefined, 'lap time'));
    table.appendChild(hdr);

    // Fastest in each column, so a pilot can see their own best sector.
    const bestPer = names.map((_, i) => {
      const times = res.laps.filter((l) => !l.invalid).map((l) => l.splits[i]?.delta ?? Infinity);
      return times.length ? Math.min(...times) : Infinity;
    });

    for (const lap of res.laps) {
      const tr = el('tr', lap.invalid ? 'invalid' : undefined);
      // The reason, not just the mark. A row struck through with nothing beside
      // it reads as the timer being broken; "2 respawns" reads as what happened.
      tr.appendChild(
        el(
          'td',
          undefined,
          lap.invalid
            ? `${lap.number} ✗ ${lap.respawns} respawn${lap.respawns === 1 ? '' : 's'}`
            : String(lap.number),
        ),
      );
      names.forEach((_, i) => {
        const sp = lap.splits[i];
        const td = el('td', undefined, sp ? sp.delta.toFixed(2) : '—');
        if (sp && !lap.invalid && Math.abs(sp.delta - bestPer[i]!) < 1e-9) td.className = 'best';
        tr.appendChild(td);
      });
      tr.appendChild(el('td', 'laptime', fmt(lap.time)));
      table.appendChild(tr);
    }
    // A scroller round it, because a course can be long: the thrust line has 41
    // checkpoints and so 43 columns, and without this the panel — and the page
    // with it — grows sideways.
    const scroll = el('div', 'race-scroll');
    scroll.appendChild(table);
    host.appendChild(scroll);

    if (res.laps.some((l) => l.invalid)) {
      host.appendChild(
        el(
          'p',
          'hint',
          'Laps marked ✗ had a respawn in them and do not count — a crash respawns you automatically, ' +
            'and pressing reset counts too. Otherwise a reset at the right moment would be a shortcut.',
        ),
      );
    }
  }

  /** Called from the tick, right after the physics step. */
  step(dt: number): void {
    this.race.setDt(dt);
    this.race.step(this.sim.pos.x, this.sim.pos.y, -this.sim.pos.z, dt);
  }
}
