/**
 * Captures a picture of the web sim for the front page: headless Chrome with
 * the software GL rasteriser, the quad placed in flight on the Race vibes map,
 * and the stage (the 3D view with its OSD) saved as a JPEG.
 *
 *   node tools/web-shot.mjs [url] [out-dir]     (default http://localhost:5180/web, public/nacosim)
 *
 * Writes web-sim.jpg (Race vibes), web-circle.jpg and web-180s.jpg.
 *
 * Needs a running server (npm run dev) and the debug handle, so run it against
 * the dev server. npm run rc:webshot. The picture is committed; re-run it when
 * the look of the sim changes.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_TO_SHOOT = process.argv[2] ?? 'http://localhost:5180/web';
const OUT_DIR = process.argv[3] ?? 'public/nacosim';
const SHOTS = [
  ['Race vibes', 'web-sim.jpg'],
  ['Circle', 'web-circle.jpg'],
  ['180s', 'web-180s.jpg'],
];
const PORT = 9722 + Math.floor(Math.random() * 400);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'fpvsim-shot-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: 'ignore' });

const done = (code) => {
  try { chrome.kill('SIGKILL'); } catch { /* gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(code);
};

let id = 1;
const pending = new Map();
const send = (ws, method, params = {}, sessionId) => {
  const n = id++;
  ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => pending.set(n, { resolve, reject }));
};

try {
  let wsUrl = '';
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(100); }
  }
  if (!wsUrl) throw new Error('Chrome never opened its debugging port');
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  };
  const { targetId } = await send(ws, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true });
  await send(ws, 'Page.enable', {}, sessionId);
  await send(ws, 'Runtime.enable', {}, sessionId);
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send(ws, 'Page.navigate', { url: URL_TO_SHOOT }, sessionId);
  await sleep(3500);
  const evaluate = async (expression) => {
    const r = await send(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  if (!(await evaluate('!!globalThis.__fpvsim'))) throw new Error('no debug handle: run this against `npm run dev`');

  mkdirSync(OUT_DIR, { recursive: true });
  for (const [trackName, file] of SHOTS) {
    // Load the map, then put the quad in flight ten metres before its first
    // checkpoint, pointing at it, nose down as in a real run. NED, so z is
    // minus the height; Euler ZYX -> quaternion.
    const placed = await evaluate(`(async () => {
      const { flight, scene } = globalThis.__fpvsim;
      const track = scene.tracks().find((t) => t.name === ${JSON.stringify(trackName)});
      if (!track || !track.course) return 'no such race map: ' + ${JSON.stringify(trackName)};
      scene.loadTrack(track);
      await new Promise((r) => setTimeout(r, 400));
      const cp = track.course.checkpoints[0];
      const sim = flight.sim;
      sim.reset(0);
      sim.armed = true;
      const yaw = Math.atan2(cp.dirE, cp.dirN);
      const roll = -6 * Math.PI / 180, pitch = -22 * Math.PI / 180;
      const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2), cp2 = Math.cos(pitch / 2), sp = Math.sin(pitch / 2), cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
      sim.q.w = cr * cp2 * cy + sr * sp * sy;
      sim.q.x = sr * cp2 * cy - cr * sp * sy;
      sim.q.y = cr * sp * cy + sr * cp2 * sy;
      sim.q.z = cr * cp2 * sy - sr * sp * cy;
      sim.pos.x = cp.north - cp.dirN * 10; sim.pos.y = cp.east - cp.dirE * 10; sim.pos.z = -(cp.up + 0.4);
      sim.vel.x = cp.dirN * 12; sim.vel.y = cp.dirE * 12; sim.vel.z = 0;
      sim.omega.x = 0; sim.omega.y = 0; sim.omega.z = 0;
      return 'ok';
    })()`);
    if (placed !== 'ok') throw new Error(placed);
    await sleep(90); // a few frames: the scene renders from the state we set
    const rect = await evaluate(`(() => { const r = globalThis.__fpvsim.scene.stage.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`);
    const shot = await send(ws, 'Page.captureScreenshot', { format: 'jpeg', quality: 82, clip: { ...rect, scale: 1 } }, sessionId);
    writeFileSync(join(OUT_DIR, file), Buffer.from(shot.data, 'base64'));
    console.log(`wrote ${join(OUT_DIR, file)} (${trackName}, ${Math.round(rect.width)}x${Math.round(rect.height)}, ${Math.round(shot.data.length * 0.75 / 1024)} KB)`);
  }
  done(0);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  done(1);
}
