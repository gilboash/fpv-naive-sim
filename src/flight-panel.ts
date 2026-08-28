/**
 * Instrumentation for the flight model. Deliberately not a 3D view.
 *
 * The brief says the feel has to be right before any art exists, and the way
 * to judge that without a scene is to watch the numbers the flight controller
 * is working with: setpoint against achieved rate, per-motor output, and where
 * the mixer runs out of room. A pilot cannot see PID tracking through a
 * rendered quad, but they can see it in a rate bar, and if the tracking is
 * wrong the scene would only hide it.
 */

import type { Commands } from './mapping.ts';
import { FlightSim } from './flight/sim.ts';
import { kronos } from './flight/airframe.ts';
import { FlightRecorder } from './flight/recorder.ts';
import { maxRate } from './flight/rates.ts';
import { AXIS_ROLL } from './flight/rates.ts';

const el = <T extends HTMLElement>(tag: string, cls?: string, text?: string): T => {
  const n = document.createElement(tag) as T;
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

interface Bar {
  root: HTMLElement;
  fill: HTMLElement;
  marker: HTMLElement;
  label: HTMLElement;
}

function rateBar(name: string): Bar {
  const root = el('div', 'fl-bar');
  root.appendChild(el('span', 'fl-bar-name', name));
  const track = el('div', 'fl-bar-track');
  const fill = el('div', 'fl-bar-fill');
  const marker = el('div', 'fl-bar-marker');
  track.appendChild(fill);
  track.appendChild(marker);
  root.appendChild(track);
  const label = el('span', 'fl-bar-val', '0');
  root.appendChild(label);
  return { root, fill, marker, label };
}

function motorBar(name: string): Bar {
  const root = el('div', 'fl-motor');
  root.appendChild(el('span', 'fl-bar-name', name));
  const track = el('div', 'fl-bar-track');
  const fill = el('div', 'fl-bar-fill up');
  track.appendChild(fill);
  root.appendChild(track);
  const label = el('span', 'fl-bar-val', '0');
  root.appendChild(label);
  return { root, fill, marker: fill, label };
}

export class FlightPanel {
  // The Kronos, not the generic racer: it is the airframe whose rotor thrust,
  // motor time constant and inertia were measured from real logs, where the
  // racer's are estimates that the same logs showed to be 43% out on thrust and
  // four times too slow on the motor. Flying the uncalibrated one was an
  // oversight — every fix from the Blackbox work was landing on an airframe the
  // simulator did not use.
  readonly sim = new FlightSim({ airframe: kronos() });
  /** 60 s at 1 kHz is the largest recording the UI offers; about 11 MB held. */
  readonly recorder = new FlightRecorder(60_000);
  /** Wall-clock microseconds spent in the last batch of physics steps. */
  stepCostUs = 0;
  /**
   * Set by whoever owns placement — the scene, when a track is loaded — so that
   * resetting puts the quad on the start line rather than at the origin.
   * Delegation rather than a second key handler, so the result does not depend
   * on which listener happens to run last.
   */
  onReset: (() => void) | null = null;

  private rateBars: Bar[];
  private motorBars: Bar[];
  private readouts: Record<string, HTMLElement> = {};
  private armBtn: HTMLButtonElement;
  private horizon: SVGGElement;
  private horizonRoll: SVGGElement;
  private statusEl: HTMLElement;
  private costEma = 0;
  private recBtn: HTMLButtonElement;
  private recProgress: HTMLElement;
  private recLinks: HTMLElement;
  private recDuration: HTMLInputElement;
  private recRate: HTMLSelectElement;

  constructor(root: HTMLElement) {
    const grid = el('div', 'fl-grid');

    // ---- left: attitude and the headline numbers
    const left = el('div', 'fl-col');
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '-100 -70 200 140');
    svg.setAttribute('class', 'fl-horizon');
    const clip = document.createElementNS(svgNS, 'clipPath');
    clip.setAttribute('id', 'fl-clip');
    const clipRect = document.createElementNS(svgNS, 'rect');
    clipRect.setAttribute('x', '-100');
    clipRect.setAttribute('y', '-70');
    clipRect.setAttribute('width', '200');
    clipRect.setAttribute('height', '140');
    clip.appendChild(clipRect);
    svg.appendChild(clip);

    const clipped = document.createElementNS(svgNS, 'g');
    clipped.setAttribute('clip-path', 'url(#fl-clip)');
    const rollG = document.createElementNS(svgNS, 'g');
    const pitchG = document.createElementNS(svgNS, 'g');
    const sky = document.createElementNS(svgNS, 'rect');
    sky.setAttribute('x', '-300');
    sky.setAttribute('y', '-400');
    sky.setAttribute('width', '600');
    sky.setAttribute('height', '400');
    sky.setAttribute('class', 'fl-sky');
    const ground = document.createElementNS(svgNS, 'rect');
    ground.setAttribute('x', '-300');
    ground.setAttribute('y', '0');
    ground.setAttribute('width', '600');
    ground.setAttribute('height', '400');
    ground.setAttribute('class', 'fl-ground');
    const horizonLine = document.createElementNS(svgNS, 'line');
    horizonLine.setAttribute('x1', '-300');
    horizonLine.setAttribute('x2', '300');
    horizonLine.setAttribute('y1', '0');
    horizonLine.setAttribute('y2', '0');
    horizonLine.setAttribute('class', 'fl-horizon-line');
    pitchG.appendChild(sky);
    pitchG.appendChild(ground);
    pitchG.appendChild(horizonLine);
    rollG.appendChild(pitchG);
    clipped.appendChild(rollG);
    svg.appendChild(clipped);

    // Fixed aircraft reference, drawn over the moving world.
    const ref = document.createElementNS(svgNS, 'path');
    ref.setAttribute('d', 'M -40 0 L -14 0 M 14 0 L 40 0 M 0 -6 L 0 6');
    ref.setAttribute('class', 'fl-ref');
    svg.appendChild(ref);
    this.horizon = pitchG;
    this.horizonRoll = rollG;
    left.appendChild(svg);

    const nums = el('div', 'fl-nums');
    for (const [key, label] of [
      ['alt', 'altitude'],
      ['spd', 'speed'],
      ['batt', 'battery'],
      ['amps', 'current'],
    ] as const) {
      const cell = el('div', 'fl-num');
      cell.appendChild(el('span', 'fl-num-label', label));
      const v = el('span', 'fl-num-val', '—');
      cell.appendChild(v);
      this.readouts[key] = v;
      nums.appendChild(cell);
    }
    left.appendChild(nums);
    grid.appendChild(left);

    // ---- right: what the controller is doing
    const right = el('div', 'fl-col');
    right.appendChild(el('h3', 'fl-h', 'rate tracking — setpoint vs gyro'));
    this.rateBars = [rateBar('roll'), rateBar('pitch'), rateBar('yaw')];
    for (const b of this.rateBars) right.appendChild(b.root);

    right.appendChild(el('h3', 'fl-h', 'motors'));
    this.motorBars = [
      motorBar('1 RR'),
      motorBar('2 FR'),
      motorBar('3 RL'),
      motorBar('4 FL'),
    ];
    for (const b of this.motorBars) right.appendChild(b.root);

    const att = el('div', 'fl-nums');
    for (const [key, label] of [
      ['roll', 'roll'],
      ['pitch', 'pitch'],
      ['yaw', 'yaw'],
      ['cost', 'physics'],
    ] as const) {
      const cell = el('div', 'fl-num');
      cell.appendChild(el('span', 'fl-num-label', label));
      const v = el('span', 'fl-num-val', '—');
      cell.appendChild(v);
      this.readouts[key] = v;
      att.appendChild(cell);
    }
    right.appendChild(att);
    grid.appendChild(right);

    root.appendChild(grid);

    // ---- controls
    const bar = el('div', 'row');
    this.armBtn = el<HTMLButtonElement>('button');
    this.armBtn.type = 'button';
    this.armBtn.textContent = 'Arm';
    this.armBtn.onclick = () => this.toggleArm();
    const resetBtn = el<HTMLButtonElement>('button');
    resetBtn.type = 'button';
    resetBtn.textContent = 'Reset';
    resetBtn.onclick = () => this.reset();
    this.statusEl = el('span', 'dim', 'disarmed');
    bar.appendChild(this.armBtn);
    bar.appendChild(resetBtn);
    bar.appendChild(this.statusEl);
    root.appendChild(bar);

    // ---- recorder
    const recRow = el('div', 'row');
    const durLabel = el('label', undefined, 'Record ');
    this.recDuration = el<HTMLInputElement>('input');
    this.recDuration.type = 'number';
    this.recDuration.min = '5';
    this.recDuration.max = '60';
    this.recDuration.step = '5';
    this.recDuration.value = '20';
    durLabel.appendChild(this.recDuration);
    durLabel.appendChild(document.createTextNode(' s at '));
    this.recRate = el<HTMLSelectElement>('select');
    for (const [v, t] of [
      ['1', '1 kHz'],
      ['2', '500 Hz'],
      ['4', '250 Hz'],
    ] as const) {
      const o = el<HTMLOptionElement>('option');
      o.value = v;
      o.textContent = t;
      this.recRate.appendChild(o);
    }
    durLabel.appendChild(this.recRate);
    recRow.appendChild(durLabel);

    this.recBtn = el<HTMLButtonElement>('button');
    this.recBtn.type = 'button';
    this.recBtn.textContent = 'Record flight';
    this.recBtn.onclick = () => this.toggleRecord();
    recRow.appendChild(this.recBtn);
    this.recProgress = el('span', 'dim', '');
    recRow.appendChild(this.recProgress);
    root.appendChild(recRow);

    this.recLinks = el('div', 'row');
    root.appendChild(this.recLinks);

    const hint = el(
      'p',
      'hint',
      'Arming refuses above 5% throttle, as a real flight controller does. ' +
        'Keys: A arm, D disarm, R reset. After a crash, R alone puts you back on the ' +
        'start line already armed, provided the throttle is down. ' +
        'Rate mode only — there is no self-levelling, ' +
        'which is the mode the brief is about. Recording captures the same fields ' +
        'Betaflight Blackbox logs, so a sim flight and a real log can be compared ' +
        'side by side.',
    );
    root.appendChild(hint);

    globalThis.addEventListener('keydown', (ev: Event) => {
      const e = ev as KeyboardEvent;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'a' || e.key === 'A') this.tryArm();
      else if (e.key === 'd' || e.key === 'D') this.disarm();
      else if (e.key === 'r' || e.key === 'R') this.reset();
    });
  }

  reset(): void {
    // Come back the way you left. Crashing is the normal outcome of practice,
    // and making a pilot re-arm after every one is friction with nothing behind
    // it: arming is a deliberate act once per session, not once per prang.
    // Throttle still has to be down, or the quad would leap off the reset.
    const wasFlying = this.sim.armed || this.sim.armedAtCrash;
    const throttleDown = this.lastInput.throttle <= 0.05;

    if (this.onReset) this.onReset();
    else this.sim.reset();

    if (wasFlying && throttleDown && this.sim.arm(this.lastInput)) {
      this.armBtn.textContent = 'Disarm';
      this.setStatus('reset — armed, ready');
      return;
    }
    this.armBtn.textContent = 'Arm';
    this.setStatus(
      wasFlying && !throttleDown
        ? 'reset — drop the throttle, then arm'
        : 'reset — throttle down, then arm',
    );
  }

  private setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  private tryArm(): void {
    if (this.sim.armed) return;
    if (this.sim.arm(this.lastInput)) {
      this.armBtn.textContent = 'Disarm';
      this.setStatus('armed');
    } else if (this.sim.crashed) {
      this.setStatus('crashed — press R or Reset first');
    } else {
      this.setStatus('refused: throttle is not down');
    }
  }

  private disarm(): void {
    this.sim.disarm();
    this.armBtn.textContent = 'Arm';
    this.setStatus('disarmed');
  }

  private toggleArm(): void {
    if (this.sim.armed) this.disarm();
    else this.tryArm();
  }

  private lastInput = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };

  /** For diagnostics only. */
  get lastInputThrottle(): number {
    return this.lastInput.throttle;
  }

  private toggleRecord(): void {
    if (this.recorder.recording) {
      this.recorder.stop();
      this.finishRecording();
      return;
    }
    const dec = Number(this.recRate.value) || 1;
    const seconds = Math.max(5, Math.min(60, Number(this.recDuration.value) || 20));
    this.recTargetSamples = Math.round((seconds * 1000) / dec);
    this.recLinks.replaceChildren();
    this.recorder.start(dec);
    this.recBtn.textContent = 'Stop';
  }

  private recTargetSamples = 0;

  private finishRecording(): void {
    this.recBtn.textContent = 'Record flight';
    const n = this.recorder.sampleCount;
    if (n === 0) {
      this.recProgress.textContent = 'nothing recorded';
      return;
    }
    const meta = this.recorder.meta(this.sim);
    this.recProgress.textContent = `${n.toLocaleString()} samples, ${meta.durationS.toFixed(1)} s`;

    const stamp = (this.recorder.startedAt || new Date().toISOString()).replace(/[:.]/g, '-');
    const add = (label: string, filename: string, build: () => string, type: string): void => {
      const b = el<HTMLButtonElement>('button');
      b.type = 'button';
      b.textContent = label;
      b.onclick = () => {
        const blob = new Blob([build()], { type });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
      };
      this.recLinks.appendChild(b);
    };
    add(
      'Download CSV',
      `fpvsim-m1-flight-${stamp}.csv`,
      () => this.recorder.toCSV(),
      'text/csv',
    );
    add(
      'Download JSON',
      `fpvsim-m1-flight-${stamp}.json`,
      () => this.recorder.toJSON(this.sim),
      'application/json',
    );
  }

  /**
   * Advance the model. Called from the 1 kHz tick, immediately after the
   * gamepad poll, which is the position M0 was built to make safe.
   */
  step(cmd: Commands, linkUp: boolean): void {
    // Failsafe. A real flight controller disarms when the link goes away, and
    // the M0 measurement is the reason this is not theoretical: the transmitter
    // dropped reports at p99 and went silent for 135 ms once inside a minute.
    // Without this the model sits armed and spooling on a dead link, which is
    // the one behaviour a trainer must never teach as normal.
    if (!linkUp && this.sim.armed) {
      this.disarm();
      this.setStatus('failsafe — no link, disarmed');
    }

    this.lastInput.throttle = cmd.throttle;
    this.lastInput.roll = cmd.roll;
    this.lastInput.pitch = cmd.pitch;
    this.lastInput.yaw = cmd.yaw;

    const t0 = performance.now();
    this.sim.step(this.lastInput);
    this.recorder.sample(this.sim);
    // A target of 0 means "until stopped, or until the buffer fills". Without
    // this guard, starting the recorder directly rather than through the button
    // stopped it after a single sample.
    if (
      this.recorder.recording &&
      this.recTargetSamples > 0 &&
      this.recorder.sampleCount >= this.recTargetSamples
    ) {
      this.recorder.stop();
      // The DOM work has to leave the tick. Anything that touches layout from
      // in here shows up as a stall in the very measurement M0 established.
      queueMicrotask(() => this.finishRecording());
    }
    const us = (performance.now() - t0) * 1000;
    // Exponential average: the per-step figure is far below timer resolution,
    // so any single reading is noise.
    this.costEma += (us - this.costEma) * 0.001;
    this.stepCostUs = this.costEma;
  }

  /** Called from the 30 Hz render loop. Never from the tick. */
  render(): void {
    const t = this.sim.telemetry;

    if (this.recorder.recording) {
      const pct = (this.recorder.sampleCount / Math.max(1, this.recTargetSamples)) * 100;
      this.recProgress.textContent =
        `recording ${Math.min(100, pct).toFixed(0)}% — ${this.recorder.sampleCount.toLocaleString()} samples`;
    }

    this.horizonRoll.setAttribute('transform', `rotate(${-t.attitude.roll})`);
    this.horizon.setAttribute('transform', `translate(0 ${t.attitude.pitch * 1.6})`);

    this.readouts.alt!.textContent = `${t.altitude.toFixed(1)} m`;
    this.readouts.spd!.textContent = `${t.speed.toFixed(1)} m/s`;
    this.readouts.batt!.textContent = `${t.batteryV.toFixed(2)} V · ${t.batteryPct.toFixed(0)}%`;
    this.readouts.amps!.textContent = `${t.batteryA.toFixed(0)} A`;
    this.readouts.roll!.textContent = `${t.attitude.roll.toFixed(0)}°`;
    this.readouts.pitch!.textContent = `${t.attitude.pitch.toFixed(0)}°`;
    this.readouts.yaw!.textContent = `${((t.attitude.yaw + 360) % 360).toFixed(0)}°`;
    this.readouts.cost!.textContent = `${this.stepCostUs.toFixed(1)} µs/step`;

    const span = Math.max(200, maxRate(this.sim.rates, AXIS_ROLL));
    const gy = [t.gyro.x, t.gyro.y, t.gyro.z];
    const sp = [t.setpoint.x, t.setpoint.y, t.setpoint.z];
    for (let i = 0; i < 3; i++) {
      const b = this.rateBars[i]!;
      const g = gy[i]!;
      const pct = ((g / span + 1) / 2) * 100;
      b.fill.style.left = `${Math.min(50, pct)}%`;
      b.fill.style.width = `${Math.abs(pct - 50)}%`;
      const spPct = ((sp[i]! / span + 1) / 2) * 100;
      b.marker.style.left = `${Math.max(0, Math.min(100, spPct))}%`;
      b.label.textContent = `${g.toFixed(0)}`;
    }

    for (let i = 0; i < this.motorBars.length; i++) {
      const b = this.motorBars[i]!;
      const out = t.motorOutputs[i] ?? 0;
      b.fill.style.left = '0%';
      b.fill.style.width = `${out * 100}%`;
      b.label.textContent = `${(t.motorRpm[i] ?? 0).toFixed(0)}`;
    }

    if (this.sim.armed) {
      this.setStatus(
        t.mixerSaturated ? 'armed — mixer saturated' : t.onGround ? 'armed — on the ground' : 'armed',
      );
    }
  }
}
