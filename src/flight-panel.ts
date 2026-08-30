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
import { QuadView } from './render/quad-view.ts';
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
  /** Fired on a successful arm, so first-run guidance can retire itself. */
  onArmed: (() => void) | null = null;

  private rateBars: Bar[];
  private motorBars: Bar[];
  private readouts: Record<string, HTMLElement> = {};
  private armBtn: HTMLButtonElement;
  quadCanvas: HTMLCanvasElement;
  /** Null when WebGL is unavailable; the rest of the panel is unaffected. */
  quadView: QuadView | null = null;
  private statusEl: HTMLElement;
  private costEma = 0;
  private recBtn: HTMLButtonElement;
  private recProgress: HTMLElement;
  private recLinks: HTMLElement;
  private recDuration: HTMLInputElement;
  private recRate: HTMLSelectElement;

  /**
   * Two hosts, because the panel serves two different moments.
   *
   * `live` is what a pilot watches while flying — battery, altitude, speed,
   * arm and reset, the recorder. `diag` is what they look at while setting up:
   * the airframe model, rate tracking, motor outputs. They were one wall of
   * numbers, which meant the flying numbers were buried among the tuning ones.
   */
  constructor(live: HTMLElement, diag: HTMLElement, quadHost: HTMLElement) {
    const root = live;
    const grid = el('div', 'fl-grid one-col');

    // ---- left: the airframe itself, and the headline numbers
    this.quadCanvas = el<HTMLCanvasElement>('canvas', 'fl-quad wide');
    quadHost.appendChild(this.quadCanvas);
    // Commanded rate per axis, beside the model. Degrees per second is how a
    // tune is written; rpm is what the rotation you are watching actually is.
    const rates = el('div', 'fl-nums');
    for (const [key, label] of [
      ['rateRoll', 'roll'],
      ['ratePitch', 'pitch'],
      ['rateYaw', 'yaw'],
    ] as const) {
      const cell = el('div', 'fl-num');
      cell.appendChild(el('span', 'fl-num-label', label));
      const v = el('span', 'fl-num-val', '—');
      cell.appendChild(v);
      this.readouts[key] = v;
      rates.appendChild(cell);
    }
    quadHost.appendChild(rates);

    const levelRow = el('div', 'row');
    const levelBtn = el<HTMLButtonElement>('button');
    levelBtn.type = 'button';
    levelBtn.textContent = 'Level it';
    levelBtn.onclick = () => this.quadView?.level();
    levelRow.appendChild(levelBtn);
    levelRow.appendChild(
      el('span', 'dim', 'It integrates, like acro — hold a stick and it keeps rotating.'),
    );
    quadHost.appendChild(levelRow);

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
    live.appendChild(nums);

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

    // Attitude reads the flight model, so by the same rule as battery and speed
    // it belongs on the flying tab, not among the tuning numbers.
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
    live.appendChild(att);
    grid.appendChild(right);

    diag.appendChild(grid);

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

    try {
      this.quadView = new QuadView(this.quadCanvas, this.sim.airframe);
    } catch {
      // No WebGL: the numbers and bars below are the useful part anyway.
      this.quadCanvas.style.display = 'none';
    }

    globalThis.addEventListener('keydown', (ev: Event) => {
      const e = ev as KeyboardEvent;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'a' || e.key === 'A') this.tryArm();
      else if (e.key === 'd' || e.key === 'D') this.disarm();
      else if (e.key === 'r' || e.key === 'R') this.reset();
    });
  }

  /**
   * Follow an arm switch, which is a level rather than an event.
   *
   * Called every tick while a switch is bound. Arming can still be refused —
   * throttle up, or a crashed quad — and a refusal must not be sticky: the
   * pilot lowers the throttle and it arms, without flicking the switch again.
   */
  setArmLevel(on: boolean, input: Commands): void {
    if (on === this.sim.armed) return;
    if (on) {
      // The caller's commands, not this.lastInput: that is only refreshed
      // inside step(), which runs after this, so it would be a tick stale.
      // Immaterial at 1 kHz and still the wrong thing to depend on.
      if (this.sim.arm(input)) {
        this.armBtn.textContent = 'Disarm';
        this.onArmed?.();
        this.setStatus('armed — from the switch');
      } else {
        this.setStatus(
          this.sim.crashed
            ? 'crashed — reset before the switch can arm'
            : 'switch is on, but the throttle is not down',
        );
      }
    } else {
      this.disarm();
      this.setStatus('disarmed — from the switch');
    }
  }

  /**
   * @param force Arm regardless of the throttle. Used by the race's automatic
   *   crash recovery: a racer is usually holding throttle when they hit
   *   something, and respawning them disarmed means they drop out of the sky a
   *   second later, which is a worse outcome than a slightly abrupt resume.
   */
  reset(force = false): void {
    // Come back the way you left. Crashing is the normal outcome of practice,
    // and making a pilot re-arm after every one is friction with nothing behind
    // it: arming is a deliberate act once per session, not once per prang.
    // Throttle still has to be down, or the quad would leap off the reset.
    const wasFlying = this.sim.armed || this.sim.armedAtCrash;
    const throttleDown = force || this.lastInput.throttle <= 0.05;

    if (this.onReset) this.onReset();
    else this.sim.reset();

    if (wasFlying && throttleDown && this.sim.arm(force ? { ...this.lastInput, throttle: 0 } : this.lastInput)) {
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
      this.onArmed?.();
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

  /**
   * The mapping-check quad, drawn every animation frame rather than at the
   * panel's 30 Hz, because a spinning prop stepped at 30 Hz strobes.
   *
   * Takes the pilot's sticks rather than simulator state: it exists to show
   * that the channels are mapped the right way round, and pointing it at the
   * flight model would only repeat what the FPV view already says.
   */
  renderQuad(cmd: Commands, rateDps: [number, number, number], nowMs: number): void {
    if (!this.quadView) return;
    this.quadView.rateDps = rateDps;
    this.quadView.render(cmd, nowMs);
    // The rate the sticks are asking for, in both the units a tune is written
    // in and the ones the rotation is actually visible at.
    const names = ['rateRoll', 'ratePitch', 'rateYaw'] as const;
    for (let i = 0; i < 3; i++) {
      const cell = this.readouts[names[i]!];
      if (!cell) continue;
      const dps = rateDps[i]!;
      cell.textContent = `${dps.toFixed(0)}°/s · ${(dps / 6).toFixed(0)} rpm`;
    }
  }

  /** Called from the 30 Hz render loop. Never from the tick. */
  render(): void {
    const t = this.sim.telemetry;

    if (this.recorder.recording) {
      const pct = (this.recorder.sampleCount / Math.max(1, this.recTargetSamples)) * 100;
      this.recProgress.textContent =
        `recording ${Math.min(100, pct).toFixed(0)}% — ${this.recorder.sampleCount.toLocaleString()} samples`;
    }


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
