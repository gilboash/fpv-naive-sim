/**
 * The Replays tab: the flights recorded in this tab, a player to watch one
 * re-flown, and a button that turns one into an MP4 to download.
 *
 * Flights live in this tab's memory and nowhere else: not in browser storage,
 * not on the server, not in the usage reports. Reloading or closing the tab
 * discards them. Only the on/off setting is remembered.
 */

import { TapeRecorder, ReplayRun, type FlightTape } from './replay/tape.ts';
import { ReplayView } from './replay/replay-view.ts';
import { makeVideo, videoUnsupported } from './replay/video.ts';
import { fmt } from './race-panel.ts';

const STORAGE_KEY = 'fpvsim.replays.v1';
/** Flights kept; the oldest goes when an eleventh arrives. */
export const MAX_FLIGHTS = 10;

const el = <T extends HTMLElement>(tag: string, cls?: string, text?: string): T => {
  const n = document.createElement(tag) as T;
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const clock = (s: number): string => {
  const m = Math.floor(s / 60);
  const r = Math.floor(s - m * 60);
  return `${m}:${String(r).padStart(2, '0')}`;
};

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'flight';

export class ReplayPanel {
  readonly recorder: TapeRecorder;
  readonly flights: FlightTape[] = [];
  /** A small recording indicator with a Stop button, for the flying tab. */
  readonly flyControl: HTMLElement;
  /** Whether the tab is on screen; set by the owner. Playback pauses when it is not. */
  visible: () => boolean = () => true;

  private enabledBox: HTMLInputElement;
  private status: HTMLElement;
  private stopBtn: HTMLButtonElement;
  private flyStatus: HTMLElement;
  private flyStop: HTMLButtonElement;
  private list: HTMLElement;
  private player: HTMLElement;
  private screen: HTMLElement;
  private playBtn: HTMLButtonElement;
  private speedSel: HTMLSelectElement;
  private seek: HTMLInputElement;
  private timeEl: HTMLElement;
  private checkEl: HTMLElement;
  private job: HTMLElement;

  private view: ReplayView | null = null;
  private viewError = '';
  private run: ReplayRun | null = null;
  private playing = false;
  private target = 0;
  private lastFrame = 0;
  private verified = false;
  private encoding: AbortController | null = null;
  private downloads: string[] = [];

  constructor(host: HTMLElement) {
    this.recorder = new TapeRecorder();
    this.recorder.enabled = this.loadEnabled();
    this.recorder.onFinished = (t) => this.add(t);

    const top = el('div', 'row');
    const lab = el('label', 'replay-toggle');
    this.enabledBox = el<HTMLInputElement>('input');
    this.enabledBox.type = 'checkbox';
    this.enabledBox.id = 'record-flights';
    this.enabledBox.checked = this.recorder.enabled;
    this.enabledBox.onchange = () => this.setEnabled(this.enabledBox.checked);
    lab.append(this.enabledBox, document.createTextNode(' Record flights'));
    this.status = el('span', 'dim', '');
    this.stopBtn = el<HTMLButtonElement>('button', undefined, 'Stop recording');
    this.stopBtn.type = 'button';
    this.stopBtn.id = 'replay-stop';
    this.stopBtn.onclick = () => this.recorder.stop();
    top.append(lab, this.stopBtn, this.status);
    host.appendChild(top);

    host.appendChild(
      el(
        'p',
        'hint',
        'Only your stick movements are recorded, not the screen. Watching one, or making a video of it, ' +
          're-flies the flight from them. A flight starts when you arm or start a race, and ends 3 s after ' +
          'you disarm, 9 s after a race finishes, when you change map, when you press Stop, or at 10 minutes. ' +
          `The last ${MAX_FLIGHTS} are kept in this tab only: nothing is stored or sent, and closing or reloading the page discards them.`,
      ),
    );

    this.list = el('div', 'replay-list');
    host.appendChild(this.list);

    this.player = el('div', 'replay-player');
    this.player.hidden = true;
    this.screen = el('div', 'replay-screen');
    this.player.appendChild(this.screen);
    const controls = el('div', 'row');
    this.playBtn = el<HTMLButtonElement>('button', undefined, 'Play');
    this.playBtn.type = 'button';
    this.playBtn.onclick = () => this.togglePlay();
    const restart = el<HTMLButtonElement>('button', undefined, 'Restart');
    restart.type = 'button';
    restart.onclick = () => {
      this.seekTo(0);
      this.setPlaying(true);
    };
    this.speedSel = el<HTMLSelectElement>('select');
    for (const v of ['0.25', '0.5', '1', '2', '4']) {
      const o = el<HTMLOptionElement>('option', undefined, `${v}×`);
      o.value = v;
      this.speedSel.appendChild(o);
    }
    this.speedSel.value = '1';
    this.seek = el<HTMLInputElement>('input', 'replay-seek');
    this.seek.type = 'range';
    this.seek.min = '0';
    this.seek.step = '20';
    this.seek.oninput = () => this.seekTo(Number(this.seek.value));
    this.timeEl = el('span', 'replay-time', '');
    controls.append(this.playBtn, restart, this.speedSel, this.seek, this.timeEl);
    this.player.appendChild(controls);
    this.checkEl = el('p', 'hint replay-check', '');
    this.player.appendChild(this.checkEl);
    host.appendChild(this.player);

    this.job = el('div', 'replay-job');
    host.appendChild(this.job);

    this.flyControl = el('span', 'replay-fly');
    this.flyStatus = el('span', 'replay-rec', '');
    this.flyStop = el<HTMLButtonElement>('button', undefined, 'Stop rec');
    this.flyStop.type = 'button';
    this.flyStop.title = 'End this flight\'s recording now (Replays tab)';
    this.flyStop.onclick = () => this.recorder.stop();
    this.flyControl.append(this.flyStatus, this.flyStop);

    this.renderList();
    this.renderStatus();
    requestAnimationFrame((t) => this.frame(t));
  }

  private loadEnabled(): boolean {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return true;
      const v = JSON.parse(raw) as { record?: unknown };
      return v.record !== false;
    } catch {
      return true;
    }
  }

  private setEnabled(on: boolean): void {
    this.recorder.setEnabled(on);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ record: on }));
    } catch {
      /* private mode */
    }
    this.renderStatus();
  }

  private add(t: FlightTape): void {
    this.flights.unshift(t);
    while (this.flights.length > MAX_FLIGHTS) {
      const gone = this.flights.pop()!;
      if (this.run?.tape === gone) this.close();
    }
    // Called from the tick: the DOM work waits for the main loop.
    queueMicrotask(() => this.renderList());
  }

  /** From the page's 30 Hz loop. */
  renderStatus(): void {
    const r = this.recorder;
    const rec = r.recording;
    const txt = !r.enabled ? 'recording is off' : rec ? `● recording ${clock(r.seconds)}` : 'waiting for you to arm';
    if (this.status.textContent !== txt) this.status.textContent = txt;
    this.stopBtn.disabled = !rec;
    const fly = rec ? `● REC ${clock(r.seconds)}` : '';
    if (this.flyStatus.textContent !== fly) this.flyStatus.textContent = fly;
    this.flyControl.style.display = rec ? '' : 'none';
  }

  private renderList(): void {
    this.list.innerHTML = '';
    if (this.flights.length === 0) {
      this.list.appendChild(el('p', 'dim', 'No flights yet. Arm and fly; each flight appears here when it ends.'));
      return;
    }
    const table = el<HTMLTableElement>('table', 'replay-table');
    const head = el('tr');
    for (const h of ['Map', 'Started', 'Length', 'Race', 'Crashes', '']) head.appendChild(el('th', undefined, h));
    table.appendChild(head);
    for (const t of this.flights) {
      const tr = el('tr');
      if (this.run?.tape === t) tr.className = 'current';
      tr.appendChild(el('td', undefined, t.trackName));
      tr.appendChild(el('td', undefined, new Date(t.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
      tr.appendChild(el('td', undefined, clock(t.ticks * t.dt)));
      const race = t.race;
      tr.appendChild(el('td', undefined, race ? `total ${fmt(race.total)}${race.best !== null ? `, best lap ${fmt(race.best)}` : ''}` : '—'));
      tr.appendChild(el('td', undefined, String(t.crashes)));
      const actions = el('td', 'replay-actions');
      const watch = el<HTMLButtonElement>('button', undefined, 'Watch');
      watch.type = 'button';
      watch.onclick = () => this.open(t);
      const video = el<HTMLButtonElement>('button', undefined, 'Make video');
      video.type = 'button';
      const no = videoUnsupported();
      video.disabled = no !== '' || this.encoding !== null;
      video.title = no;
      video.onclick = () => void this.video(t);
      const del = el<HTMLButtonElement>('button', undefined, 'Delete');
      del.type = 'button';
      del.disabled = this.encoding !== null;
      del.onclick = () => {
        const i = this.flights.indexOf(t);
        if (i >= 0) this.flights.splice(i, 1);
        if (this.run?.tape === t) this.close();
        this.renderList();
      };
      actions.append(watch, video, del);
      tr.appendChild(actions);
      table.appendChild(tr);
    }
    this.list.appendChild(table);
  }

  private ensureView(): ReplayView | null {
    if (this.view || this.viewError) return this.view;
    try {
      this.view = new ReplayView(1280, 720);
      this.view.out.className = 'replay-canvas';
      this.screen.appendChild(this.view.out);
    } catch (e) {
      this.viewError = e instanceof Error ? e.message : String(e);
      this.screen.appendChild(el('p', 'hint', `No replay view: ${this.viewError}`));
    }
    return this.view;
  }

  /** Watch a flight from the start. */
  open(t: FlightTape): void {
    const view = this.ensureView();
    this.player.hidden = false;
    if (!view) return;
    this.run = new ReplayRun(t, view.prepare(t));
    this.target = 0;
    this.verified = false;
    this.checkEl.textContent = '';
    this.seek.max = String(t.ticks);
    this.renderList();
    this.draw();
    this.setPlaying(true);
  }

  private close(): void {
    this.run = null;
    this.setPlaying(false);
    this.player.hidden = true;
  }

  private setPlaying(on: boolean): void {
    this.playing = on && this.run !== null;
    if (this.run && this.playing && this.run.done) this.seekTo(0);
    this.playBtn.textContent = this.playing ? 'Pause' : 'Play';
  }

  private togglePlay(): void {
    this.setPlaying(!this.playing);
  }

  private seekTo(tick: number): void {
    if (!this.run) return;
    this.target = Math.max(0, Math.min(this.run.tape.ticks, Math.round(tick)));
    // Back: a keyframe and a few steps, so do it now. Forward: the frame loop
    // re-flies towards the target a slice at a time, so a long jump never
    // freezes the page.
    if (this.target < this.run.tick) this.run.runTo(this.target);
    this.draw();
  }

  private frame(now: number): void {
    requestAnimationFrame((t) => this.frame(t));
    const dtMs = Math.min(100, now - (this.lastFrame || now));
    this.lastFrame = now;
    const run = this.run;
    if (!run || this.encoding) return;
    if (!this.visible()) {
      if (this.playing) this.setPlaying(false);
      return;
    }
    if (this.playing) this.target = Math.min(run.tape.ticks, this.target + dtMs * Number(this.speedSel.value));
    if (run.tick < this.target) {
      const t0 = performance.now();
      while (run.tick < this.target && performance.now() - t0 < 25) {
        const stop = Math.min(this.target, run.tick + 200);
        run.runTo(stop);
      }
      this.draw();
    }
    if (run.done) {
      if (this.playing) this.setPlaying(false);
      if (!this.verified) {
        this.verified = true;
        const d = run.verify();
        this.checkEl.textContent =
          d === undefined
            ? ''
            : d === null
              ? 'Re-flown exactly: the end of the replay matches the live flight to the last bit.'
              : `The replay drifted from the live flight (${d}). Please tell us which browser this was.`;
        this.checkEl.classList.toggle('bad', d !== null && d !== undefined);
      }
    }
  }

  private draw(): void {
    const run = this.run;
    if (!run || !this.view) return;
    this.view.draw(run);
    if (document.activeElement !== this.seek) this.seek.value = String(run.tick);
    this.timeEl.textContent = `${clock(run.seconds)} / ${clock(run.tape.ticks * run.tape.dt)}`;
  }

  private async video(t: FlightTape): Promise<void> {
    const view = this.ensureView();
    if (!view || this.encoding) return;
    this.setPlaying(false);
    this.player.hidden = false;
    const abort = new AbortController();
    this.encoding = abort;
    this.renderList();
    this.job.innerHTML = '';
    const label = el('span', undefined, 'Making the video…');
    const bar = el<HTMLProgressElement>('progress');
    bar.max = 1;
    bar.value = 0;
    const cancel = el<HTMLButtonElement>('button', undefined, 'Cancel');
    cancel.type = 'button';
    cancel.onclick = () => abort.abort();
    this.job.append(label, bar, cancel);
    const t0 = performance.now();
    try {
      const blob = await makeVideo(
        t,
        view,
        (p) => {
          bar.value = p.frame / p.frames;
          label.textContent = `Making the video… ${Math.round((p.frame / p.frames) * 100)}%`;
        },
        abort.signal,
      );
      const url = URL.createObjectURL(blob);
      this.downloads.push(url);
      const name = `nacosim-${slug(t.trackName)}-${new Date(t.startedAt).toISOString().slice(0, 16).replace(/[-:T]/g, '')}.mp4`;
      this.job.innerHTML = '';
      const a = el<HTMLAnchorElement>('a', 'button-link', `Download ${name}`);
      a.href = url;
      a.download = name;
      a.id = 'replay-download';
      const secs = ((performance.now() - t0) / 1000).toFixed(0);
      this.job.append(a, el('span', 'dim', ` ${(blob.size / 1e6).toFixed(1)} MB, made in ${secs} s`));
      this.lastVideo = blob;
    } catch (e) {
      const cancelled = e instanceof DOMException && e.name === 'AbortError';
      this.job.textContent = cancelled ? 'Cancelled.' : `Could not make the video: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      this.encoding = null;
      this.renderList();
      if (this.run) {
        view.prepare(this.run.tape);
        this.draw();
      }
    }
  }

  /** The last video made, for the browser check. */
  lastVideo: Blob | null = null;
}
