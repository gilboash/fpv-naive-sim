/**
 * Usage reporting, so the person hosting this can see who is flying it.
 *
 * Until this file existed the page was entirely client-side, and that was a
 * deliberate property rather than an accident of not having got round to a
 * backend. So the rules here are tighter than they would be for a normal
 * analytics shim:
 *
 *   - **Summaries, not a stream.** One object describing the whole session,
 *     resent as it grows. Nothing is recorded per input, per frame or per
 *     position, so nothing here can reconstruct a flight.
 *   - **No fingerprinting and no addresses.** A random id the pilot can erase
 *     from Settings, an optional name they typed themselves, and counters.
 *   - **It goes to the machine serving the page and nowhere else.** A relative
 *     URL, so there is no third party to be trusted.
 *   - **Off in a dev build.** `npm run dev` has no ingest endpoint, and a
 *     developer's own flying is the last thing worth putting in the data.
 *
 * Resending the whole summary rather than deltas is what makes a lost beacon
 * harmless: every record supersedes the last one for its session id, so the
 * reader takes the newest and needs no reassembly.
 */

const PILOT_KEY = 'fpvsim.pilot.v1';
const OPT_KEY = 'fpvsim.telemetry.v1';
const ENDPOINT = '/api/session';
const HEARTBEAT_MS = 60_000;

/** What one map was used for, this session. */
export interface MapUse {
  name: string;
  /** Seconds spent armed on it. Time on the page is not time flying. */
  armedS: number;
  loads: number;
  crashes: number;
  races: number;
  laps: number;
  bestLap: number | null;
  bestThree: number | null;
}

export interface SessionReport {
  v: 1;
  sessionId: string;
  pilotId: string;
  name: string;
  build: string;
  startedAt: string;
  sentAt: string;
  /** Wall-clock seconds since the page loaded. */
  uptimeS: number;
  /** How many times this session has been reported, including this one. */
  reports: number;
  secure: boolean;
  isolated: boolean;
  maps: MapUse[];
  armedS: number;
  crashes: number;
  tune: unknown;
}

interface StoredPilot {
  version: 1;
  id: string;
  name: string;
}

interface StoredOptIn {
  version: 1;
  enabled: boolean;
}

function randomId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Old browser, or an insecure origin where crypto is partly absent. Still
  // needs to be unique enough that two pilots do not collide.
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode, quota — not worth failing over */
  }
}

export class Telemetry {
  readonly pilotId: string;
  readonly sessionId = randomId();
  name: string;
  enabled: boolean;

  /**
   * False in a dev build. Kept separate from `enabled` so the Settings toggle
   * still reads back what the pilot chose while developing, rather than
   * appearing to be off because nothing is being sent.
   */
  readonly transmits: boolean;

  /** Set by the owner; called at send time so the tune is never stale. */
  tuneSnapshot: (() => unknown) | null = null;

  private readonly startedAt = new Date();
  private readonly maps = new Map<string, MapUse>();
  private reports = 0;
  private lastSignature = '';
  private crashes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  // The armed accumulator runs at 1 kHz, so the map entry is cached rather
  // than looked up by name a thousand times a second.
  private currentName = '';
  private current: MapUse | null = null;

  constructor(transmits = !import.meta.env.DEV) {
    this.transmits = transmits;
    const stored = read<StoredPilot>(PILOT_KEY);
    if (stored && typeof stored.id === 'string' && stored.id.length > 0) {
      this.pilotId = stored.id;
      this.name = typeof stored.name === 'string' ? stored.name : '';
    } else {
      this.pilotId = randomId();
      this.name = '';
      write(PILOT_KEY, { version: 1, id: this.pilotId, name: '' } satisfies StoredPilot);
    }
    // Default on. The toggle in Settings is what makes that honest, and the
    // absence of the key means the pilot has not been asked yet — which is
    // "on" by the decision behind this feature, not by oversight.
    const opt = read<StoredOptIn>(OPT_KEY);
    this.enabled = opt ? opt.enabled !== false : true;
  }

  setName(name: string): void {
    this.name = name.slice(0, 60).trim();
    write(PILOT_KEY, { version: 1, id: this.pilotId, name: this.name } satisfies StoredPilot);
  }

  setEnabled(on: boolean): void {
    // Send the final summary *before* going quiet, so turning it off does not
    // silently discard the flying already done. Turning it on sends nothing
    // extra; the heartbeat picks it up.
    if (this.enabled && !on) this.send();
    this.enabled = on;
    write(OPT_KEY, { version: 1, enabled: on } satisfies StoredOptIn);
  }

  private entry(name: string): MapUse {
    let e = this.maps.get(name);
    if (!e) {
      e = { name, armedS: 0, loads: 0, crashes: 0, races: 0, laps: 0, bestLap: null, bestThree: null };
      this.maps.set(name, e);
    }
    return e;
  }

  /** A map was selected, or the page loaded with one. */
  noteMap(name: string): void {
    this.entry(name).loads++;
  }

  /** Hot path: called from the tick while the quad is armed. */
  noteArmed(name: string, dt: number): void {
    if (name !== this.currentName) {
      this.currentName = name;
      this.current = this.entry(name);
    }
    if (this.current) this.current.armedS += dt;
  }

  noteCrash(name: string): void {
    this.crashes++;
    this.entry(name).crashes++;
  }

  noteRace(name: string, laps: number, best: number | null, bestThree: number | null): void {
    const e = this.entry(name);
    e.races++;
    e.laps += laps;
    if (best !== null && (e.bestLap === null || best < e.bestLap)) e.bestLap = best;
    if (bestThree !== null && (e.bestThree === null || bestThree < e.bestThree)) e.bestThree = bestThree;
  }

  report(): SessionReport {
    const maps = [...this.maps.values()].map((m) => ({ ...m, armedS: Math.round(m.armedS * 10) / 10 }));
    return {
      v: 1,
      sessionId: this.sessionId,
      pilotId: this.pilotId,
      name: this.name,
      build: __FPVSIM_BUILD__,
      startedAt: this.startedAt.toISOString(),
      sentAt: new Date().toISOString(),
      uptimeS: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
      reports: this.reports + 1,
      secure: globalThis.isSecureContext === true,
      isolated: globalThis.crossOriginIsolated === true,
      maps,
      armedS: Math.round(maps.reduce((a, m) => a + m.armedS, 0) * 10) / 10,
      crashes: this.crashes,
      tune: this.tuneSnapshot?.() ?? null,
    };
  }

  /**
   * Returns false when nothing was sent, which the checks rely on to tell
   * "opted out" from "the beacon was refused".
   */
  send(): boolean {
    if (!this.enabled || !this.transmits) return false;
    const report = this.report();
    // Nothing has changed since the last one, so there is nothing to say. An
    // idle tab posts once and then goes quiet, and the two events that both
    // fire when a tab goes away — pagehide and visibilitychange — do not each
    // leave a copy of the same summary in the file.
    const signature = JSON.stringify([report.name, report.crashes, report.maps, report.tune]);
    if (signature === this.lastSignature) return false;
    this.lastSignature = signature;
    const body = JSON.stringify(report);
    this.reports++;
    try {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon?.(ENDPOINT, blob)) return true;
    } catch {
      /* fall through to fetch */
    }
    try {
      // keepalive so a fetch started during pagehide is allowed to finish.
      void fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Two triggers, because neither alone is enough: `pagehide` is the only event
   * that reliably fires on a closing tab, and a heartbeat is the only thing
   * that survives a browser which never fires it (or a machine put to sleep
   * with the tab open, which is how a long session ends in practice).
   */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.send(), HEARTBEAT_MS);
    globalThis.addEventListener('pagehide', () => this.send());
    // visibilitychange as well: on mobile a tab is frequently frozen without
    // ever being hidden in the pagehide sense.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.send();
    });
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
