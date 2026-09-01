/**
 * Motor sound, synthesised from the flight model's own rotor speeds.
 *
 * Pilots hear a quad before they see it respond — throttle, loading in a turn,
 * a prop unloading over the top of a flip. None of that is decoration; it is
 * the earliest cue in the loop, which is why it is worth having in a trainer.
 *
 * **Synthesis, not samples.** There is no asset to load, nothing to fetch, and
 * the pitch comes out right at every rpm rather than at the three the samples
 * were recorded at. It is also what keeps the page a handful of static files
 * with nothing to download at run time.
 *
 * **Off means off.** With sound disabled the AudioContext is closed and the
 * whole graph goes away, so the cost is one property check per rendered frame
 * and nothing on the audio thread at all. That is a requirement rather than an
 * optimisation: the simulator's timing story is the reason anyone trusts it,
 * and a feature nobody asked for must not be able to spend any of it.
 *
 * The physics never sees this file. `update()` reads telemetry the model has
 * already produced and is called from the 30 Hz render path, never from the
 * 1 kHz tick — a crash schedules a flag that the render loop picks up, so no
 * node is ever allocated inside the tick.
 */

import type { FlightSim } from './flight/sim.ts';

const STORAGE_KEY = 'fpvsim.audio.v1';

interface Stored {
  version: 1;
  enabled: boolean;
  volume: number;
}

/**
 * Smoothing constant for every parameter ramp, seconds.
 *
 * `setTargetAtTime` is an exponential approach, so this is what stops a 30 Hz
 * update from stepping audibly. Too long and the throttle feels laggy in the
 * ear when it is not laggy in the model, which would be the worst outcome for
 * a trainer — a false cue is worse than no cue.
 */
const RAMP = 0.025;

/** One clamp, used everywhere. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class FlightAudio {
  enabled: boolean;
  volume: number;

  /** Called whenever state changes, so more than one control can show it. */
  onChange: (() => void) | null = null;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private motorBus: BiquadFilterNode | null = null;
  private oscs: OscillatorNode[] = [];
  private oscGains: GainNode[] = [];
  private noise: AudioBufferSourceNode | null = null;
  private airFilter: BiquadFilterNode | null = null;
  private airGain: GainNode | null = null;
  private wave: PeriodicWave | null = null;

  /** Blade-pass multiplier and an rpm scale, both from the airframe. */
  private blades = 3;
  private refRpm = 30000;

  /** Set from the tick, consumed by update(). See the file header. */
  private pendingCrash = 0;
  private pendingChime: 'gate' | 'flag' | 'lap' | null = null;

  /** Live voices, so a check can see that a crash actually made a sound. */
  private voices = 0;

  constructor() {
    let enabled = true;
    let volume = 0.6;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw) as Stored;
        if (s.version === 1) {
          enabled = s.enabled !== false;
          if (typeof s.volume === 'number') volume = clamp(s.volume, 0, 1);
        }
      }
    } catch {
      // A corrupt setting should cost the default, not the page.
    }
    this.enabled = enabled;
    this.volume = volume;
  }

  /** True when there is a live audio graph. The checks read this. */
  get active(): boolean {
    return this.ctx !== null;
  }

  /**
   * The node everything is mixed into, before the limiter.
   *
   * Exposed so a tap can record what is actually being heard —
   * `tools/sound-preview.mjs` writes a WAV from it. Reading parameters back
   * says the graph was *asked* for the right thing; a recording is the only
   * thing that says it sounds like anything at all.
   */
  get output(): AudioNode | null {
    return this.master;
  }

  /** 'running', 'suspended', or 'closed' when there is no context. */
  get state(): string {
    return this.ctx ? this.ctx.state : 'closed';
  }

  get liveVoices(): number {
    return this.voices;
  }

  /**
   * Browsers refuse to start audio without a gesture, and a pilot flying from a
   * radio may not make one for a while — so this is armed on the first click or
   * keypress and also called directly by the toggle, which is itself a gesture.
   */
  attachGesture(): void {
    const once = (): void => {
      if (this.enabled) this.ensure();
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
    };
    globalThis.addEventListener('pointerdown', once);
    globalThis.addEventListener('keydown', once);
    // A tab in the background gets its rAF throttled to a crawl, which would
    // leave the last frequencies droning. Silence rather than freeze.
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.visibilityState === 'hidden') void this.ctx.suspend();
      else void this.ctx.resume();
    });
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.ensure();
    else this.teardown();
    this.save();
    this.onChange?.();
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.masterGain, this.ctx.currentTime, RAMP);
    }
    this.save();
    this.onChange?.();
  }

  /** Perceptual rather than linear: a slider at half should sound half. */
  private get masterGain(): number {
    return this.volume * this.volume * 0.9;
  }

  private save(): void {
    try {
      const s: Stored = { version: 1, enabled: this.enabled, volume: this.volume };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      /* private mode, quota — not worth failing over */
    }
  }

  /** Called from the tick. Records the impact; makes no sound and no garbage. */
  noteCrash(speed: number): void {
    if (speed > this.pendingCrash) this.pendingCrash = speed;
  }

  /**
   * A checkpoint went by. Queued rather than played, like a crash, so the tick
   * stays free of the audio graph.
   *
   * A gate and a flag sound different because they are different things to have
   * got right, and a completed lap is different again — in a race the pilot is
   * looking at the next gate, not at the clock, so the lap has to arrive in the
   * ear.
   */
  noteCheckpoint(kind: 'gate' | 'flag' | 'lap'): void {
    this.pendingChime = kind;
  }

  /**
   * Build the graph. Four oscillators, one per motor, because the beating
   * between them as the mixer splits the motors *is* the sound of a quad
   * working — a single tone scaled by mean rpm sounds like a hair dryer.
   */
  private ensure(): void {
    if (this.ctx) return;
    const Ctor = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return; // No Web Audio: everything below degrades to silence.
    let ctx: AudioContext;
    try {
      ctx = new Ctor();
    } catch {
      return;
    }
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = this.masterGain;
    // A limiter, not an effect: four oscillators plus noise plus a crash burst
    // can sum past full scale, and clipping sounds like a bug in the model.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    master.connect(limiter).connect(ctx.destination);
    this.master = master;

    // A few harmonics rather than a pure tone. A motor is not a sine and a
    // sawtooth is far too buzzy; this is between the two and cheap.
    const real = new Float32Array([0, 0, 0, 0, 0, 0, 0]);
    const imag = new Float32Array([0, 1, 0.45, 0.28, 0.16, 0.09, 0.05]);
    this.wave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });

    const bus = ctx.createBiquadFilter();
    bus.type = 'lowpass';
    bus.frequency.value = 900;
    bus.Q.value = 0.7;
    bus.connect(master);
    this.motorBus = bus;

    for (let i = 0; i < 4; i++) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(this.wave);
      osc.frequency.value = 200;
      // A few cents apart, so four motors at identical rpm still beat slightly
      // rather than summing into one sterile tone.
      osc.detune.value = (i - 1.5) * 7;
      const g = ctx.createGain();
      g.gain.value = 0;
      osc.connect(g).connect(bus);
      osc.start();
      this.oscs.push(osc);
      this.oscGains.push(g);
    }

    // Broadband air noise, which is what separates a quad from an organ pipe.
    // One buffer, looped: no per-frame allocation and no fetch.
    const noise = ctx.createBufferSource();
    noise.buffer = whiteNoise(ctx, 2);
    noise.loop = true;
    const air = ctx.createBiquadFilter();
    air.type = 'bandpass';
    air.frequency.value = 1200;
    air.Q.value = 0.6;
    const airGain = ctx.createGain();
    airGain.gain.value = 0;
    noise.connect(air).connect(airGain).connect(master);
    noise.start();
    this.noise = noise;
    this.airFilter = air;
    this.airGain = airGain;

    if (ctx.state === 'suspended') void ctx.resume();
    this.onChange?.();
  }

  private teardown(): void {
    const ctx = this.ctx;
    // Stop the sources explicitly before closing. close() would take them with
    // it, but a source left running while its context goes away is the kind of
    // thing that leaks in one browser and not the others.
    try {
      for (const o of this.oscs) o.stop();
      this.noise?.stop();
    } catch {
      /* already stopped */
    }
    this.ctx = null;
    this.master = null;
    this.motorBus = null;
    this.oscs = [];
    this.oscGains = [];
    this.noise = null;
    this.airFilter = null;
    this.airGain = null;
    this.wave = null;
    this.voices = 0;
    this.pendingCrash = 0;
    if (!ctx) return;
    // close() releases the audio thread entirely. Suspending would leave the
    // graph alive and the promise of "exactly like now when off" unkept.
    void ctx.close().catch(() => {});
  }

  /**
   * Drive the graph from one step of telemetry. Called at 30 Hz; every
   * parameter is a smoothed target rather than a step, so the ear cannot hear
   * the update rate.
   */
  update(sim: FlightSim): void {
    if (!this.enabled) return;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;

    const t = ctx.currentTime;
    const tel = sim.telemetry;
    const rpms = tel.motorRpm;

    let meanNorm = 0;
    for (let i = 0; i < this.oscs.length; i++) {
      const rpm = rpms[i] ?? 0;
      const norm = clamp(rpm / this.refRpm, 0, 1.2);
      meanNorm += norm;
      // Blade pass, which is the tone a prop actually makes: once per blade
      // past a point, not once per revolution.
      const hz = clamp((rpm / 60) * this.blades, 20, 6000);
      this.oscs[i]!.frequency.setTargetAtTime(hz, t, RAMP);
      // Loudness grows faster than rpm and never quite reaches full, so there
      // is headroom for the crash.
      this.oscGains[i]!.gain.setTargetAtTime(Math.min(0.22, norm * norm * 0.5), t, RAMP);
    }
    meanNorm /= Math.max(1, this.oscs.length);

    // The bus opens up under load, which is most of what "working hard" sounds
    // like — the harmonics come through rather than the fundamental alone.
    this.motorBus?.frequency.setTargetAtTime(600 + meanNorm * 5200, t, RAMP);

    // Air noise from both the disc and the airframe's own speed, so a fast
    // pass sounds fast even at a steady throttle.
    const speedNorm = clamp(tel.speed / 30, 0, 1.4);
    this.airGain?.gain.setTargetAtTime(
      clamp(meanNorm * 0.10 + speedNorm * 0.07, 0, 0.22),
      t,
      RAMP,
    );
    this.airFilter?.frequency.setTargetAtTime(700 + meanNorm * 2600 + speedNorm * 900, t, RAMP);

    if (this.pendingCrash > 0) {
      this.bang(this.pendingCrash);
      this.pendingCrash = 0;
    }
    if (this.pendingChime) {
      this.chime(this.pendingChime);
      this.pendingChime = null;
    }
  }

  /**
   * The sound of getting one right.
   *
   * Short and bright, and pitched well above the motors so it cuts through
   * rather than fighting them: at full throttle the blade pass is already
   * around 1.2 kHz, and a confirmation the pilot has to strain for is worse
   * than none. A lap is three notes rising, which is the one that can afford
   * to be longer because nothing is being aimed at in that instant.
   */
  private chime(kind: 'gate' | 'flag' | 'lap'): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    // Pitched well clear of the rotors. At full throttle blade pass is already
    // about 1.4 kHz with harmonics above it, and the first version sat a chime
    // at 1 244 Hz — straight into the loudest thing on the mix, where it was
    // indistinguishable from the motor sweeping past the same note. These sit
    // above the fundamental and are short and sharp, which is what separates
    // them from a steady tone even where the spectra overlap.
    const notes: [number, number, number][] =
      kind === 'lap'
        ? [
            [1568, 0, 0.13],
            [2093, 0.1, 0.13],
            [2794, 0.2, 0.36],
          ]
        : kind === 'flag'
          ? [[1760, 0, 0.18]]
          : [[2349, 0, 0.14]];
    for (const [hz, delay, dur] of notes) {
      const t0 = t + delay;
      const osc = ctx.createOscillator();
      // Triangle: enough edge to carry over broadband rotor noise, without the
      // buzz a sawtooth would add to a sound that plays several times a lap.
      osc.type = 'triangle';
      // A small downward glide. A dead-steady tone reads as part of the motor
      // noise; a falling one reads as an event.
      osc.frequency.setValueAtTime(hz, t0);
      osc.frequency.exponentialRampToValueAtTime(hz * 0.94, t0 + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
      this.voices++;
      osc.onended = () => {
        this.voices = Math.max(0, this.voices - 1);
      };
    }
  }

  /**
   * An impact: a broadband burst for the plastic, and a low thud for the mass.
   *
   * Built on demand and discarded — a crash is one event in tens of thousands
   * of ticks, so a permanent voice would be four filters idling for the sake of
   * something that happens once a minute.
   */
  private bang(speed: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const hardness = clamp(speed / 12, 0.25, 1);

    const burst = ctx.createBufferSource();
    burst.buffer = whiteNoise(ctx, 0.5);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1800, t);
    bp.frequency.exponentialRampToValueAtTime(320, t + 0.3);
    bp.Q.value = 0.8;
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.exponentialRampToValueAtTime(0.75 * hardness, t + 0.006);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.05 + 0.35 * hardness);
    burst.connect(bp).connect(bg).connect(master);

    const thud = ctx.createOscillator();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(120, t);
    thud.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, t);
    tg.gain.exponentialRampToValueAtTime(0.6 * hardness, t + 0.008);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    thud.connect(tg).connect(master);

    const stop = t + 0.5 + 0.35 * hardness;
    burst.start(t);
    burst.stop(stop);
    thud.start(t);
    thud.stop(stop);
    this.voices += 2;
    const done = (): void => {
      this.voices = Math.max(0, this.voices - 1);
    };
    burst.onended = done;
    thud.onended = done;
  }

  /**
   * What the graph is doing right now, for the browser check.
   *
   * Reads the *computed* AudioParam values rather than the targets, so it sees
   * what is actually being heard — a check against the value we asked for would
   * pass even if nothing were connected.
   */
  debug(): { freqs: number[]; gains: number[]; busHz: number; air: number; voices: number } {
    return {
      freqs: this.oscs.map((o) => o.frequency.value),
      gains: this.oscGains.map((g) => g.gain.value),
      busHz: this.motorBus?.frequency.value ?? 0,
      air: this.airGain?.gain.value ?? 0,
      voices: this.voices,
    };
  }

  /**
   * Blade count and rpm scale come from the airframe, so a different quad
   * sounds different for the reason it should. The scale is 60% of the unloaded
   * rpm, which is about where a 5" sits at full throttle with a prop on it —
   * measured at 28 000 against an unloaded 52 000 on the NACRONOS.
   */
  setAirframe(sim: FlightSim): void {
    const af = sim.airframe;
    this.blades = Math.max(1, af.prop.blades);
    this.refRpm = Math.max(1000, af.motor.kv * af.battery.cells * af.battery.cellFull * 0.6);
  }
}

/** One second or two of white noise, reused by looping. */
function whiteNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}
