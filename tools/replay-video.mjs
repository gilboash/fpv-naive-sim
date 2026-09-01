/**
 * Turn a recorded flight into a video, through the real page.
 *
 *   node tools/replay-video.mjs lap.json out.mp4 [url]
 *   (needs `npm run dev` running, for the dev-only debug handle, and ffmpeg)
 *
 * The picture comes from the actual renderer with the actual stick overlay, so
 * what you watch is what a pilot would have seen — not a plot of the same data
 * in a different program.
 *
 * The one trick: the page runs its own 1 kHz physics, which would fight a
 * replay for ownership of the aircraft. Rather than trying to synchronise with
 * it, `sim.step` is made a no-op for the duration, so the model holds exactly
 * the state each frame is set to and the page renders it. The physics is not
 * being replayed here — it already happened, in `tools/optimal-lap.ts`. This is
 * a camera.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [lapFile, outFile = 'lap.mp4', url = 'http://localhost:5180/'] = process.argv.slice(2);
if (!lapFile) {
  console.error('usage: node tools/replay-video.mjs lap.json [out.mp4] [url]');
  process.exit(2);
}

const lap = JSON.parse(readFileSync(lapFile, 'utf8'));
const frames = lap.samples;
console.log(`${lap.course}: ${frames.length} frames at ${lap.hz} Hz, laps ${lap.laps.map((t) => t.toFixed(2)).join(' / ')}`);

const PORT = 9100 + Math.floor(Math.random() * 150);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = mkdtempSync(join(tmpdir(), 'fpvsim-video-'));
const shots = mkdtempSync(join(tmpdir(), 'fpvsim-frames-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--window-size=1440,900',
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
await send('Page.navigate', { url }, sessionId);
await sleep(3500);

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
  console.error('no debug handle — this needs the dev server, not a built page');
  chrome.kill('SIGKILL');
  process.exit(2);
}

const setup = await evaluate(`(async () => {
  const { scene, flight, tabs, racePanel } = globalThis.__fpvsim;
  tabs.show('fly');
  const sel = document.querySelectorAll('#scene-view select')[0];
  const names = [...sel.options].map((o) => o.textContent);
  const idx = names.findIndex((n) => n === ${JSON.stringify(lap.course)});
  if (idx < 0) return { ok: false, names };
  sel.value = String(idx);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));

  // The page owns the physics; for a replay it must not. Making the step a
  // no-op is simpler and more reliable than racing it every frame.
  flight.sim.step = () => {};

  // And it owns the stick overlay, which it redraws every frame from the live
  // radio — with no radio that is four zeroes, so it quietly wiped the recorded
  // sticks between the moment they were set and the moment the screenshot was
  // taken. The first video showed a motionless left stick for a whole lap.
  // Neutralised the same way, with the real one kept for the replay to call.
  globalThis.__replayUpdateSticks = scene.updateSticks.bind(scene);
  scene.updateSticks = () => {};
  flight.sim.armed = true;
  flight.sim.crashed = false;
  racePanel.race.reset();

  const c = document.querySelector('#scene-view canvas');
  c.scrollIntoView({ block: 'center' });
  const b = c.getBoundingClientRect();
  return {
    ok: true,
    map: names[idx],
    clip: { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height, scale: 1 },
  };
})()`);

if (!setup.ok) {
  console.error(`no map called "${lap.course}" — the page offers: ${setup.names.join(', ')}`);
  chrome.kill('SIGKILL');
  process.exit(2);
}
console.log(`map "${setup.map}", capturing ${Math.round(setup.clip.width)}x${Math.round(setup.clip.height)}`);

// Every other sample: 30 fps is plenty for a line, and halves the capture time,
// which is dominated by the screenshot round trip rather than by drawing.
const stride = 2;
const fps = lap.hz / stride;
let n = 0;
for (let i = 0; i < frames.length; i += stride) {
  const f = frames[i];
  await evaluate(`(() => {
    const { scene, flight, mapping } = globalThis.__fpvsim;
    const s = flight.sim;
    s.pos.x = ${f.n}; s.pos.y = ${f.e}; s.pos.z = ${-f.u};
    s.q.w = ${f.qw}; s.q.x = ${f.qx}; s.q.y = ${f.qy}; s.q.z = ${f.qz};
    // The panels read telemetry rather than the raw state, so it is set too —
    // otherwise the OSD reports a stationary quad over a moving picture.
    s.telemetry.speed = ${f.speed};
    s.telemetry.altitude = ${f.u};
    s.telemetry.batteryV = ${f.batteryV};
    s.telemetry.batteryA = ${f.batteryA};
    scene.render();
    globalThis.__replayUpdateSticks({ throttle: ${f.throttle}, roll: ${f.roll}, pitch: ${f.pitch}, yaw: ${f.yaw} }, mapping.mode);
  })()`);
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: setup.clip }, sessionId);
  writeFileSync(join(shots, `f${String(n).padStart(5, '0')}.png`), Buffer.from(shot.result.data, 'base64'));
  n++;
  if (n % 60 === 0) process.stdout.write(`\r  ${n} frames…`);
}
process.stdout.write(`\r  ${n} frames captured\n`);

chrome.kill('SIGKILL');
rmSync(profile, { recursive: true, force: true });

const ff = spawnSync(
  'ffmpeg',
  ['-y', '-framerate', String(fps), '-i', join(shots, 'f%05d.png'),
   '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', outFile],
  { encoding: 'utf8' },
);
if (ff.status !== 0) {
  console.error(ff.stderr?.split('\n').slice(-8).join('\n'));
  process.exit(1);
}
rmSync(shots, { recursive: true, force: true });
console.log(`${outFile}: ${n} frames at ${fps} fps, ${(n / fps).toFixed(1)} s`);
