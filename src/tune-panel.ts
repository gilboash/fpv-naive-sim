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
import { applyRates, defaultRates, RATE_FIELDS, type RateProfile } from './flight/rates.ts';
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
  private pidHost: HTMLElement | null = null;
  private pidInputs: HTMLInputElement[][] = [];
  private filterInputs = new Map<string, HTMLInputElement>();
  private applyTimer: ReturnType<typeof setTimeout> | null = null;
  private rates: RateProfile = defaultRates();
  private pids: PidProfile = defaultPids();
  private inputs: HTMLInputElement[][] = [];
  private headings: HTMLElement[] = [];
  private typeSel: HTMLSelectElement;
  private summary: HTMLElement;
  private status: HTMLElement;
  private curve: SVGPathElement;

  /**
   * One owner of the tune, two views onto it.
   *
   * Rates belong in Settings and PIDs in Instruments, but they are one tune and
   * one storage key. Two panels each owning half of it, both writing
   * `fpvsim.tune.v1`, would be a race waiting to happen and would leave the
   * Blackbox import updating only one of them.
   */
  constructor(root: HTMLElement, sim: FlightSim, pidHost?: HTMLElement) {
    this.sim = sim;
    this.pidHost = pidHost ?? null;
    this.load();

    const controls = el('div', 'row');
    this.typeSel = el<HTMLSelectElement>('select');
    for (const [v, label] of [
      ['actual', 'Actual'],
      ['betaflight', 'Betaflight'],
      ['kiss', 'KISS'],
    ] as const) {
      const o = el<HTMLOptionElement>('option');
      o.value = v;
      o.textContent = label;
      this.typeSel.appendChild(o);
    }
    this.typeSel.value = this.rates.type;
    this.typeSel.onchange = () => {
      this.rates.type = this.typeSel.value as RateProfile['type'];
      // The three curves do not share field names or units, so the headings and
      // the values on screen both have to change with the type.
      this.relabel();
      this.writeInputs();
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
      this.relabel();
      this.writeInputs();
      this.writePidInputs();
      this.apply();
      this.status.textContent = 'back to defaults';
    };
    controls.appendChild(reset);

    this.status = el('span', 'dim', '');
    controls.appendChild(this.status);
    root.appendChild(controls);

    // ---- the three rate rows
    const grid = el('div', 'tune-grid');
    grid.appendChild(el('span', 'tune-head', ''));
    for (let f = 0; f < 3; f++) this.headings.push(el('span', 'tune-head', ''));
    for (const h of this.headings) grid.appendChild(h);
    grid.appendChild(el('span', 'tune-head', 'centre'));
    grid.appendChild(el('span', 'tune-head', 'max'));
    AXES.forEach((axis, ai) => {
      grid.appendChild(el('span', 'tune-axis', axis));
      const row: HTMLInputElement[] = [];
      for (let f = 0; f < 3; f++) {
        const input = el<HTMLInputElement>('input');
        input.type = 'number';
        input.min = '0';
        input.oninput = () => {
          const shown = Number(input.value);
          if (!Number.isFinite(shown)) return;
          // On screen these are configurator units; stored they are
          // Betaflight's internal ones. Convert here and nowhere else.
          const scale = RATE_FIELDS[this.rates.type][f]!.scale;
          const target = f === 0 ? this.rates.rcRate : f === 1 ? this.rates.rate : this.rates.expo;
          target[ai] = shown / scale;
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

    if (this.pidHost) this.buildPidPanel(this.pidHost);

    this.relabel();
    this.writeInputs();
    this.apply();
  }

  // ------------------------------------------------------------ PID editing

  private buildPidPanel(host: HTMLElement): void {
    host.innerHTML = '';

    const grid = el('div', 'tune-grid pid-grid');
    for (const h of ['', 'P', 'I', 'D', 'F', 'D min']) {
      grid.appendChild(el('span', 'tune-head', h));
    }
    AXES.forEach((axis, ai) => {
      grid.appendChild(el('span', 'tune-axis', axis));
      const row: HTMLInputElement[] = [];
      for (const field of ['p', 'i', 'd', 'f', 'dMin'] as const) {
        const input = el<HTMLInputElement>('input');
        input.type = 'number';
        input.min = '0';
        input.max = '250';
        input.step = '1';
        input.oninput = () => {
          const v = Number(input.value);
          if (!Number.isFinite(v)) return;
          if (field === 'dMin') {
            const arr = (this.pids.dMin ??= [0, 0, 0]);
            arr[ai] = v;
          } else {
            this.pids[AXES[ai]!][field] = v;
          }
          this.scheduleApply();
        };
        row.push(input);
        grid.appendChild(input);
      }
      this.pidInputs.push(row);
    });
    host.appendChild(grid);

    const filters = el('div', 'row');
    const addFilter = (
      key: string,
      label: string,
      get: () => number,
      set: (v: number) => void,
    ): void => {
      const wrap = el('label', undefined, `${label} `);
      const input = el<HTMLInputElement>('input');
      input.type = 'number';
      input.min = '0';
      input.max = '2000';
      input.step = '5';
      input.value = String(Math.round(get()));
      input.oninput = () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) {
          set(v);
          this.scheduleApply();
        }
      };
      wrap.appendChild(input);
      wrap.appendChild(document.createTextNode(' Hz'));
      filters.appendChild(wrap);
      this.filterInputs.set(key, input);
    };
    addFilter('gyro', 'Gyro LPF', () => this.pids.gyroLowpassHz, (v) => (this.pids.gyroLowpassHz = v));
    addFilter('dterm', 'D LPF', () => this.pids.dtermLowpassHz, (v) => (this.pids.dtermLowpassHz = v));
    addFilter('dterm2', 'D LPF 2', () => this.pids.dtermLowpass2Hz ?? 0, (v) => (this.pids.dtermLowpass2Hz = v));
    addFilter('ff', 'FF smoothing', () => this.pids.feedforwardSmoothHz ?? 125, (v) => (this.pids.feedforwardSmoothHz = v));
    host.appendChild(filters);

    this.pidStatus = el('p', 'hint', '');
    host.appendChild(this.pidStatus);
    this.writePidInputs();
  }

  private pidStatus: HTMLElement | null = null;

  private writePidInputs(): void {
    this.pidInputs.forEach((row, ai) => {
      const g = this.pids[AXES[ai]!];
      row[0]!.value = String(g.p);
      row[1]!.value = String(g.i);
      row[2]!.value = String(g.d);
      row[3]!.value = String(g.f);
      row[4]!.value = String(this.pids.dMin?.[ai] ?? 0);
    });
    for (const [key, input] of this.filterInputs) {
      const v =
        key === 'gyro' ? this.pids.gyroLowpassHz
        : key === 'dterm' ? this.pids.dtermLowpassHz
        : key === 'dterm2' ? (this.pids.dtermLowpass2Hz ?? 0)
        : (this.pids.feedforwardSmoothHz ?? 125);
      input.value = String(Math.round(v));
    }
  }

  /**
   * Debounced, because applyTune() rebuilds the RateController — which zeroes
   * the integrators and the filter state. Doing that on every keystroke means
   * a jolt per digit typed while airborne, and typing "120" would apply 1, then
   * 12, then 120.
   */
  private scheduleApply(): void {
    if (this.applyTimer !== null) clearTimeout(this.applyTimer);
    if (this.pidStatus) this.pidStatus.textContent = 'editing…';
    this.applyTimer = setTimeout(() => {
      this.applyTimer = null;
      this.apply();
      if (this.pidStatus) {
        this.pidStatus.textContent = this.sim.armed
          ? 'applied — the controller was rebuilt, so I-terms and filters restarted'
          : 'applied';
      }
    }, 700);
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

  /** Column headings follow the rate type, as a configurator's do. */
  private relabel(): void {
    const fields = RATE_FIELDS[this.rates.type];
    this.headings.forEach((h, f) => {
      const spec = fields[f]!;
      h.textContent = spec.unit ? `${spec.label} (${spec.unit})` : spec.label;
    });
    for (const row of this.inputs) {
      row.forEach((input, f) => {
        input.step = String(fields[f]!.step);
      });
    }
  }

  private writeInputs(): void {
    const fields = RATE_FIELDS[this.rates.type];
    const store = [this.rates.rcRate, this.rates.rate, this.rates.expo];
    this.inputs.forEach((row, ai) => {
      row.forEach((input, f) => {
        const shown = store[f]![ai]! * fields[f]!.scale;
        // Two decimals for the 0..1 fields, whole numbers for deg/s.
        input.value = fields[f]!.scale < 1 ? shown.toFixed(2) : String(Math.round(shown));
      });
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
      this.relabel();
      this.writeInputs();
      this.writePidInputs();
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
