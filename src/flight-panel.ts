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
  readonly sim = new FlightSim();
  /** Wall-clock microseconds spent in the last batch of physics steps. */
  stepCostUs = 0;

  private rateBars: Bar[];
  private motorBars: Bar[];
  private readouts: Record<string, HTMLElement> = {};
  private armBtn: HTMLButtonElement;
  private horizon: SVGGElement;
  private horizonRoll: SVGGElement;
  private statusEl: HTMLElement;
  private costEma = 0;

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
    resetBtn.onclick = () => {
      this.sim.reset();
      this.setStatus('reset — throttle down, then arm');
    };
    this.statusEl = el('span', 'dim', 'disarmed');
    bar.appendChild(this.armBtn);
    bar.appendChild(resetBtn);
    bar.appendChild(this.statusEl);
    root.appendChild(bar);

    const hint = el(
      'p',
      'hint',
      'Arming refuses above 5% throttle, as a real flight controller does. ' +
        'Keys: A arm, D disarm, R reset. Rate mode only — there is no self-levelling, ' +
        'which is the mode the brief is about.',
    );
    root.appendChild(hint);

    globalThis.addEventListener('keydown', (ev: Event) => {
      const e = ev as KeyboardEvent;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'a' || e.key === 'A') this.tryArm();
      else if (e.key === 'd' || e.key === 'D') this.disarm();
      else if (e.key === 'r' || e.key === 'R') this.sim.reset();
    });
  }

  private setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  private tryArm(): void {
    if (this.sim.armed) return;
    if (this.sim.arm(this.lastInput)) {
      this.armBtn.textContent = 'Disarm';
      this.setStatus('armed');
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
    const us = (performance.now() - t0) * 1000;
    // Exponential average: the per-step figure is far below timer resolution,
    // so any single reading is noise.
    this.costEma += (us - this.costEma) * 0.001;
    this.stepCostUs = this.costEma;
  }

  /** Called from the 30 Hz render loop. Never from the tick. */
  render(): void {
    const t = this.sim.telemetry;

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
