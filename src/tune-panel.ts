/**
 * Rates and PIDs, editable, and importable from a Blackbox log.
 *
 * This exists because a pilot asked where he was supposed to enter his rates,
 * and the answer was that he could not: the model had been flying its own
 * defaults — 800 deg/s at full stick against his quad's 512 — which is a 55%
 * difference in the one thing a trainer is for. Transferable muscle memory is
 * the product; the rate curve is most of it.
 *
 * The import button is the point. Every value here already exists in the header
 * of any Blackbox log, so the reliable way to fly your own quad is to hand over
 * a log rather than retype a dozen numbers from a configurator.
 */

import type { FlightSim } from './flight/sim.ts';
import { applyRates, defaultRates, type RateProfile } from './flight/rates.ts';
import { defaultPids, type PidProfile } from './flight/pid.ts';
import { readHeaderOnly } from './flight/blackbox.ts';
import { tuneFromHeader } from './flight/tune.ts';

const STORAGE_KEY = 'fpvsim.tune.v1';
const AXES = ['roll', 'pitch', 'yaw'] as const;

const el = <T extends HTMLElement>(tag: string, cls?: string, text?: string): T => {
  const n = document.createElement(tag) as T;
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

interface Stored {
  version: 1;
  rates: RateProfile;
  pids: PidProfile;
}

export class TunePanel {
  private sim: FlightSim;
  private rates: RateProfile = defaultRates();
  private pids: PidProfile = defaultPids();
  private inputs: HTMLInputElement[][] = [];
  private typeSel: HTMLSelectElement;
  private summary: HTMLElement;
  private status: HTMLElement;
  private curve: SVGPathElement;

  constructor(root: HTMLElement, sim: FlightSim) {
    this.sim = sim;
    this.load();

    const controls = el('div', 'row');
    this.typeSel = el<HTMLSelectElement>('select');
    for (const [v, label] of [
      ['actual', 'Actual'],
      ['betaflight', 'Betaflight / KISS'],
    ] as const) {
      const o = el<HTMLOptionElement>('option');
      o.value = v;
      o.textContent = label;
      this.typeSel.appendChild(o);
    }
    this.typeSel.value = this.rates.type;
    this.typeSel.onchange = () => {
      this.rates.type = this.typeSel.value as RateProfile['type'];
      this.apply();
    };
    const tl = el('label', undefined, 'Rate curve ');
    tl.appendChild(this.typeSel);
    controls.appendChild(tl);

    const file = el<HTMLInputElement>('input');
    file.type = 'file';
    file.accept = '.bbl,.bfl,.BBL,.BFL';
    file.style.display = 'none';
    file.onchange = () => {
      const f = file.files?.[0];
      if (f) void this.importLog(f);
      file.value = '';
    };
    const importBtn = el<HTMLButtonElement>('button');
    importBtn.type = 'button';
    importBtn.textContent = 'Load from Blackbox log';
    importBtn.onclick = () => file.click();
    controls.appendChild(importBtn);
    controls.appendChild(file);

    const reset = el<HTMLButtonElement>('button');
    reset.type = 'button';
    reset.textContent = 'Defaults';
    reset.onclick = () => {
      this.rates = defaultRates();
      this.pids = defaultPids();
      this.typeSel.value = this.rates.type;
      this.writeInputs();
      this.apply();
      this.status.textContent = 'back to defaults';
    };
    controls.appendChild(reset);

    this.status = el('span', 'dim', '');
    controls.appendChild(this.status);
    root.appendChild(controls);

    // ---- the three rate rows
    const grid = el('div', 'tune-grid');
    for (const h of ['', 'RC rate', 'Rate', 'Expo', 'centre', 'max']) {
      grid.appendChild(el('span', 'tune-head', h));
    }
    AXES.forEach((axis, ai) => {
      grid.appendChild(el('span', 'tune-axis', axis));
      const row: HTMLInputElement[] = [];
      for (let f = 0; f < 3; f++) {
        const input = el<HTMLInputElement>('input');
        input.type = 'number';
        input.step = '1';
        input.min = '0';
        input.max = '250';
        input.oninput = () => {
          const v = Number(input.value);
          if (!Number.isFinite(v)) return;
          const target = f === 0 ? this.rates.rcRate : f === 1 ? this.rates.rate : this.rates.expo;
          target[ai] = v;
          this.apply();
        };
        row.push(input);
        grid.appendChild(input);
      }
      this.inputs.push(row);
      grid.appendChild(el('span', 'tune-val', '—'));
      grid.appendChild(el('span', 'tune-val', '—'));
    });
    root.appendChild(grid);

    // ---- stick-to-rate curve, because numbers alone do not show shape
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 200 100');
    svg.setAttribute('class', 'tune-curve');
    const axisLine = document.createElementNS(svgNS, 'path');
    axisLine.setAttribute('d', 'M0 50 H200 M100 0 V100');
    axisLine.setAttribute('class', 'tune-axisline');
    svg.appendChild(axisLine);
    this.curve = document.createElementNS(svgNS, 'path');
    this.curve.setAttribute('class', 'tune-curveline');
    svg.appendChild(this.curve);
    const caption = el('p', 'hint', 'Stick against commanded rate, roll axis.');
    root.appendChild(svg);
    root.appendChild(caption);

    this.summary = el('p', 'hint', '');
    root.appendChild(this.summary);

    this.writeInputs();
    this.apply();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as Stored;
      if (s.version !== 1) return;
      if (s.rates) this.rates = s.rates;
      if (s.pids) this.pids = s.pids;
    } catch {
      // A corrupt stored tune should cost the defaults, not the page.
    }
  }

  private save(): void {
    try {
      const s: Stored = { version: 1, rates: this.rates, pids: this.pids };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      /* private mode, quota — not worth failing over */
    }
  }

  private writeInputs(): void {
    this.inputs.forEach((row, ai) => {
      row[0]!.value = String(this.rates.rcRate[ai]);
      row[1]!.value = String(this.rates.rate[ai]);
      row[2]!.value = String(this.rates.expo[ai]);
    });
  }

  private async importLog(f: File): Promise<void> {
    this.status.textContent = `reading ${f.name}…`;
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      const header = readHeaderOnly(buf, 0);
      const tune = tuneFromHeader(header.raw);
      this.rates = tune.rates;
      this.pids = tune.pids;
      this.typeSel.value = this.rates.type;
      this.writeInputs();
      this.apply();
      this.status.textContent =
        `loaded ${tune.craftName || 'tune'}` + (tune.firmware ? ` · ${tune.firmware}` : '');
    } catch (e) {
      this.status.textContent = `could not read it: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private apply(): void {
    this.sim.applyTune(this.rates, this.pids);
    this.save();

    // Centre sensitivity and full-stick rate, per axis.
    const cells = [...(this.inputs[0]![0]!.parentElement?.querySelectorAll('.tune-val') ?? [])];
    AXES.forEach((_, ai) => {
      const centre = Math.abs(applyRates(this.rates, ai, 0.1)) * 10;
      const max = Math.abs(applyRates(this.rates, ai, 1));
      const c = cells[ai * 2] as HTMLElement | undefined;
      const m = cells[ai * 2 + 1] as HTMLElement | undefined;
      if (c) c.textContent = `${centre.toFixed(0)}°/s`;
      if (m) m.textContent = `${max.toFixed(0)}°/s`;
    });

    const max = Math.max(1, Math.abs(applyRates(this.rates, 0, 1)));
    const pts: string[] = [];
    for (let i = 0; i <= 80; i++) {
      const stick = -1 + (2 * i) / 80;
      const r = applyRates(this.rates, 0, stick);
      pts.push(`${(100 + stick * 100).toFixed(1)} ${(50 - (r / max) * 48).toFixed(1)}`);
    }
    this.curve.setAttribute('d', `M${pts.join('L')}`);

    const p = this.pids;
    this.summary.textContent =
      `Roll PID ${p.roll.p}/${p.roll.i}/${p.roll.d} FF ${p.roll.f} · ` +
      `pitch ${p.pitch.p}/${p.pitch.i}/${p.pitch.d} FF ${p.pitch.f} · ` +
      `yaw ${p.yaw.p}/${p.yaw.i}/${p.yaw.d} · ` +
      `gyro LPF ${p.gyroLowpassHz.toFixed(0)} Hz, D LPF ${p.dtermLowpassHz.toFixed(0)} Hz. ` +
      `Loading a log brings all of these across as well as the rates.`;
  }
}
