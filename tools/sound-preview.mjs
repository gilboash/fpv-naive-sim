/**
 * Record what the simulator sounds like, without flying it and without a human.
 *
 * Drives `FlightAudio` through a scripted rpm profile in a real browser, taps
 * the graph, and writes a WAV. The point is that sound is the one thing in this
 * project that cannot be checked by reading a number back: `audio.debug()` says
 * the oscillator was *asked* for 1 200 Hz, which is true of a graph that is
 * silent, wrongly balanced, or clipping. This produces something to listen to.
 *
 * Usage: node tools/sound-preview.mjs [out.wav] [url]
 *        (needs `npm run dev` running, for the dev-only debug handle)
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] ?? 'fpvsim-sound.wav';
const URL_TO_CHECK = process.argv[3] ?? 'http://localhost:5180/';
const PORT = 9800 + Math.floor(Math.random() * 150);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const profile = mkdtempSync(join(tmpdir(), 'fpvsim-sound-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    // No speakers in headless, but the graph still runs — and without this the
    // context waits for a gesture that this script cannot make.
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function browserWs() {
  for (let i = 0; i < 100; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error('Chrome never opened its debugging port');
}

const sock = new WebSocket(await browserWs());
await new Promise((r) => (sock.onopen = r));
let id = 0;
const pending = new Map();
sock.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    sock.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Page.navigate', { url: URL_TO_CHECK }, sessionId);
await sleep(3000);

const evaluate = async (expr) => {
  const r = await send(
    'Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed');
  }
  return r.result?.result?.value;
};

if (!(await evaluate('!!globalThis.__fpvsim'))) {
  console.error('no debug handle — this needs the dev server (npm run dev), not a built page');
  chrome.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
  process.exit(2);
}

/**
 * The flight this records. Written out rather than flown, so the same seconds
 * come back every time and two versions can be compared by ear.
 */
const captured = await evaluate(`(async () => {
  const { audio } = globalThis.__fpvsim;
  audio.setEnabled(true);
  audio.setVolume(0.8);
  const ctx = audio.output.context;

  // Tap the mix. ScriptProcessor is deprecated and perfect for this: it hands
  // over the samples on the main thread with no worklet module to load.
  const tap = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  let frames = 0;
  const wanted = Math.floor(ctx.sampleRate * 14);
  tap.onaudioprocess = (e) => {
    if (frames >= wanted) return;
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    frames += e.inputBuffer.length;
  };
  audio.output.connect(tap);
  // A ScriptProcessor only runs while it is connected onward, and the mix is
  // already going to the destination through the limiter — so this second path
  // is silenced rather than left to double the signal.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  tap.connect(mute).connect(ctx.destination);

  const feed = (rpm, speed) =>
    audio.update({ telemetry: { motorRpm: rpm, speed } });

  // Seconds of a flight, as rpm per motor. Idle, a punch out, a roll (motors
  // split), cruise, a chop, then the ground.
  const script = [
    { t: 1.2, rpm: () => [5200, 5200, 5200, 5200], speed: 0 },
    { t: 1.6, rpm: (f) => { const r = 5200 + f * 20000; return [r, r, r, r]; }, speed: (f) => f * 12 },
    { t: 1.4, rpm: (f) => {
        const b = 24000, d = Math.sin(f * Math.PI * 3) * 6500;
        return [b + d, b - d, b - d, b + d];
      }, speed: 22 },
    { t: 1.6, rpm: () => [17000, 17000, 17000, 17000], speed: 26 },
    { t: 1.0, rpm: (f) => { const r = 17000 - f * 11000; return [r, r, r, r]; }, speed: (f) => 26 - f * 18 },
    { t: 1.2, rpm: () => [6000, 6000, 6000, 6000], speed: 6 },
  ];

  // Checkpoints, dropped in where a pilot would actually take them: a gate on
  // the way up, a flag mid-roll, another gate on the exit, and a lap on the
  // way out of cruise.
  const marks = [[1, 0.5, 'gate'], [2, 0.35, 'flag'], [3, 0.7, 'gate'], [3, 0.95, 'lap']];

  const stepMs = 33;                     // the rate the render loop drives it at
  for (let s = 0; s < script.length; s++) {
    const seg = script[s];
    const steps = Math.round((seg.t * 1000) / stepMs);
    for (let i = 0; i < steps; i++) {
      const f = i / steps;
      for (const [segIdx, at, kind] of marks) {
        if (segIdx === s && f >= at && f - 1 / steps < at) audio.noteCheckpoint(kind);
      }
      feed(seg.rpm(f), typeof seg.speed === 'function' ? seg.speed(f) : seg.speed);
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }

  // Clipping a gate, then the thing you hear once per session.
  audio.noteStrike(7);
  feed([9000, 9000, 9000, 9000], 14);
  await new Promise((r) => setTimeout(r, 900));

  // And the thing you hear once per session.
  audio.noteCrash(11);
  feed([6000, 6000, 6000, 6000], 6);
  await new Promise((r) => setTimeout(r, 400));
  feed([0, 0, 0, 0], 2);
  await new Promise((r) => setTimeout(r, 1400));

  tap.onaudioprocess = null;
  audio.output.disconnect(tap);

  // Interleave to 16-bit and hand it back as base64. A Float32 array over CDP
  // would be an array of numbers in JSON, which is ten times the size.
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const pcm = new Int16Array(total);
  let k = 0, peak = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const v = Math.max(-1, Math.min(1, c[i]));
      if (Math.abs(v) > peak) peak = Math.abs(v);
      pcm[k++] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
  }
  let bin = '';
  const bytes = new Uint8Array(pcm.buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return { b64: btoa(bin), rate: ctx.sampleRate, frames: total, peak };
})()`);

chrome.kill('SIGKILL');
rmSync(profile, { recursive: true, force: true });

const pcm = Buffer.from(captured.b64, 'base64');
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(captured.rate, 24);
header.writeUInt32LE(captured.rate * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);
writeFileSync(OUT, Buffer.concat([header, pcm]));

console.log(
  `${OUT}: ${(captured.frames / captured.rate).toFixed(1)} s at ${captured.rate} Hz, peak ${captured.peak.toFixed(3)}`,
);
if (captured.peak < 0.01) console.log('  warning: that is silence — the tap caught nothing');
process.exit(0);
