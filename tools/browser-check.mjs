/**
 * Verifies the page in a real browser, without a human.
 *
 * Launches headless Chrome with a debugging port, drives it over CDP, and
 * collects everything the page complains about. Two things this deliberately
 * does not do:
 *
 *   - `--dump-dom --virtual-time-budget` hangs. The page runs a rAF loop and a
 *     1 kHz worker ticker, so virtual time never goes idle and Chrome waits
 *     forever. This cost an afternoon in M0; do not reintroduce it.
 *   - It does not assume "no exception thrown" means "it works". The checks at
 *     the bottom read state back out of the running page.
 *
 * Usage: node tools/browser-check.mjs [url]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_TO_CHECK = process.argv[2] ?? 'http://localhost:5180/';
const PORT = 9222 + Math.floor(Math.random() * 500);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const profile = mkdtempSync(join(tmpdir(), 'fpvsim-cdp-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Headless has no GPU, so WebGL2 needs the software rasteriser turned on
    // explicitly. Without these the renderer is simply absent and every scene
    // check silently passes as "gracefully degraded", which is exactly the kind
    // of green tick that means nothing.
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function browserWs() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error('Chrome never opened its debugging port');
}

let nextId = 1;
const pending = new Map();

function send(ws, method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const problems = [];
const consoleLines = [];

function cleanup(code) {
  try {
    chrome.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  process.exit(code);
}

const main = async () => {
  const wsUrl = await browserWs();
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error)})`));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      problems.push(`exception: ${d.exception?.description ?? d.text}`);
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      consoleLines.push(`[${e.level}] ${e.text}`);
      if (e.level === 'error') problems.push(`log error: ${e.text}`);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      consoleLines.push(`[console.${msg.params.type}] ${text}`);
      if (msg.params.type === 'error') problems.push(`console.error: ${text}`);
    }
  };

  const { targetId } = await send(ws, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true });

  await send(ws, 'Runtime.enable', {}, sessionId);
  await send(ws, 'Log.enable', {}, sessionId);
  await send(ws, 'Page.enable', {}, sessionId);

  await send(ws, 'Page.navigate', { url: URL_TO_CHECK }, sessionId);
  await sleep(3500); // let the module load, the worker start, and rAF settle

  const evaluate = async (expression) => {
    const r = await send(
      ws,
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  };

  let failed = 0;
  const check = (name, condition, detail) => {
    if (condition) {
      console.log(`  \x1b[32mPASS\x1b[0m ${name} — ${detail}`);
    } else {
      failed++;
      console.log(`  \x1b[31mFAIL\x1b[0m ${name} — ${detail}`);
    }
  };

  console.log(`\n\x1b[1mBrowser check: ${URL_TO_CHECK}\x1b[0m`);

  const isolated = await evaluate('globalThis.crossOriginIsolated === true');
  check('cross-origin isolated', isolated, isolated ? 'yes — SharedArrayBuffer available' : 'no');

  const backend = await evaluate(
    `document.querySelectorAll('#status-pills .pill')[1]?.textContent ?? '(none)'`,
  );
  check('ticker backend', /atomics/.test(backend), backend);

  const hasPanel = await evaluate(`!!document.querySelector('#flight-panel .fl-grid')`);
  check('flight panel rendered', hasPanel, hasPanel ? 'present' : 'missing');

  // The model must actually be stepping, which means the tick is reaching it.
  const t1 = await evaluate('globalThis.__fpvsim.flight.sim.time');
  await sleep(1000);
  const t2 = await evaluate('globalThis.__fpvsim.flight.sim.time');
  const advanced = t2 - t1;
  check(
    'physics advancing at ~1 kHz',
    advanced > 0.85 && advanced < 1.15,
    `${advanced.toFixed(3)} s of simulated time per second of wall clock`,
  );

  const cost = await evaluate('globalThis.__fpvsim.flight.stepCostUs');
  check('step cost inside budget', cost >= 0 && cost < 200, `${cost.toFixed(1)} us/step`);

  // Arm and fly it from the page, with no radio attached.
  const flightResult = await evaluate(`(() => {
    const { flight } = globalThis.__fpvsim;
    const sim = flight.sim;
    sim.reset();
    if (!sim.arm({ throttle: 0, roll: 0, pitch: 0, yaw: 0 })) return { error: 'arm refused' };
    const start = sim.telemetry.altitude;
    for (let i = 0; i < 3000; i++) sim.step({ throttle: 0.35, roll: 0, pitch: 0, yaw: 0 });
    const climbed = sim.telemetry.altitude - start;
    for (let i = 0; i < 2000; i++) sim.step({ throttle: 0.35, roll: 0.4, pitch: 0, yaw: 0 });
    return {
      climbed,
      rollRate: sim.telemetry.gyro.x,
      setpoint: sim.telemetry.setpoint.x,
      rpm: sim.telemetry.motorRpm[0],
      volts: sim.telemetry.batteryV,
      finite: Number.isFinite(sim.pos.z) && Number.isFinite(sim.q.w),
    };
  })()`);

  check(
    'arms and climbs on throttle',
    !flightResult.error && flightResult.climbed > 1,
    flightResult.error ?? `${flightResult.climbed.toFixed(2)} m in 3 s at 35% throttle`,
  );
  check(
    'tracks a roll command in the browser',
    Math.abs(flightResult.rollRate - flightResult.setpoint) < 20,
    `${flightResult.rollRate?.toFixed(0)} vs ${flightResult.setpoint?.toFixed(0)} deg/s setpoint`,
  );
  check('state stays finite in the browser', flightResult.finite === true, 'no NaN');

  // Failsafe: armed, then the link drops. It has to disarm itself.
  const failsafe = await evaluate(`(() => {
    const { flight } = globalThis.__fpvsim;
    flight.sim.reset();
    flight.sim.arm({ throttle: 0, roll: 0, pitch: 0, yaw: 0 });
    const armedBefore = flight.sim.armed;
    flight.step({ throttle: 0.5, roll: 0, pitch: 0, yaw: 0 }, false);
    return { armedBefore, armedAfter: flight.sim.armed };
  })()`);
  check(
    'failsafe disarms when the link drops',
    failsafe.armedBefore === true && failsafe.armedAfter === false,
    `armed ${failsafe.armedBefore} -> ${failsafe.armedAfter} after a step with no link`,
  );

  // The recorder, driven by the real 1 kHz tick rather than a loop.
  const rec = await evaluate(`(async () => {
    const { flight } = globalThis.__fpvsim;
    flight.sim.reset();
    flight.sim.arm({ throttle: 0, roll: 0, pitch: 0, yaw: 0 });
    flight.recorder.start(1);
    await new Promise((r) => setTimeout(r, 1500));
    flight.recorder.stop();
    const csv = flight.recorder.toCSV();
    const lines = csv.split(String.fromCharCode(10));
    const head = lines[0].split(',');
    const body = lines.slice(1);
    const numeric = body.slice(0, 500).every((l) => {
      const cells = l.split(',');
      return cells.length === head.length && cells.every((v) => Number.isFinite(Number(v)));
    });
    const json = JSON.parse(flight.recorder.toJSON(flight.sim));
    return {
      samples: flight.recorder.sampleCount,
      csvRows: body.length,
      cols: head.length,
      numeric,
      jsonRows: json.rows.length,
      jsonCols: json.meta.columns.length,
      hasTime: head[0] === 'time',
      hasGyro: head.includes('gyroADC[0]'),
      hasMotor: head.includes('motor[0]'),
      sampleHz: json.meta.sampleHz,
    };
  })()`);

  check(
    'recorder samples at the tick rate',
    rec.samples > 1300 && rec.samples < 1700,
    `${rec.samples} samples in 1.5 s (meta says ${rec.sampleHz} Hz)`,
  );
  check('CSV row count matches sample count', rec.csvRows === rec.samples, `${rec.csvRows} rows`);
  check(
    'CSV is rectangular and numeric',
    rec.numeric === true,
    `${rec.cols} columns, first 500 rows all finite`,
  );
  check(
    'Blackbox-shaped field names present',
    rec.hasTime && rec.hasGyro && rec.hasMotor,
    'time, gyroADC[0], motor[0]',
  );
  check(
    'JSON export agrees with CSV',
    rec.jsonRows === rec.samples && rec.jsonCols === rec.cols,
    `${rec.jsonRows} rows x ${rec.jsonCols} columns`,
  );

  // The button path: duration, auto-stop, and the download links appearing.
  const uiRec = await evaluate(`(async () => {
    const { flight } = globalThis.__fpvsim;
    const panel = document.querySelector('#flight-panel');
    const dur = panel.querySelector('input[type=number]');
    const btn = [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Record flight');
    dur.value = '5';
    btn.click();
    const startedLabel = btn.textContent;
    await new Promise((r) => setTimeout(r, 6000));
    const links = [...panel.querySelectorAll('button')].map((b) => b.textContent);
    return {
      startedLabel,
      stoppedLabel: btn.textContent,
      samples: flight.recorder.sampleCount,
      recording: flight.recorder.recording,
      links: links.filter((t) => t.startsWith('Download')),
    };
  })()`);

  check(
    'record button starts and auto-stops at the set duration',
    uiRec.startedLabel === 'Stop' && uiRec.stoppedLabel === 'Record flight' && !uiRec.recording,
    `label ${uiRec.startedLabel} -> ${uiRec.stoppedLabel}, ${uiRec.samples} samples for a 5 s run`,
  );
  check(
    'auto-stopped at the right length',
    uiRec.samples >= 4900 && uiRec.samples <= 5100,
    `${uiRec.samples} samples (expected ~5000)`,
  );
  check(
    'download links appear when recording finishes',
    uiRec.links.length === 2,
    uiRec.links.join(', ') || 'none',
  );

  // The 3D view. "No exception thrown" would pass even with WebGL missing
  // entirely, because SceneView degrades gracefully on purpose — so this reads
  // pixels back off the canvas and checks the frame is not a flat fill.
  const scenePixels = await evaluate(`(() => {
    const { scene, flight } = globalThis.__fpvsim;
    if (!scene.available) return { ok: false, reason: 'no renderer' };
    // Put the quad in the air, facing down the gate run, and draw.
    flight.sim.reset(0);
    flight.sim.pos.x = -30; flight.sim.pos.y = 0; flight.sim.pos.z = -2.5;
    flight.sim.onGround = false;
    scene.render();
    const c = scene.canvas;
    const off = document.createElement('canvas');
    off.width = c.width; off.height = c.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, off.width, off.height).data;
    let min = [255,255,255], max = [0,0,0], n = 0;
    for (let i = 0; i < d.length; i += 4 * 97) {
      for (let k = 0; k < 3; k++) {
        if (d[i+k] < min[k]) min[k] = d[i+k];
        if (d[i+k] > max[k]) max[k] = d[i+k];
      }
      n++;
    }
    const spread = Math.max(max[0]-min[0], max[1]-min[1], max[2]-min[2]);
    return { ok: true, w: c.width, h: c.height, spread, samples: n, cost: scene.renderer?.frameCostMs ?? 0 };
  })()`);

  check(
    'WebGL2 renderer available',
    scenePixels.ok === true,
    scenePixels.ok ? 'yes' : `no — ${scenePixels.reason}`,
  );
  if (scenePixels.ok) {
    check(
      'canvas has a real backing size',
      scenePixels.w > 100 && scenePixels.h > 100,
      `${scenePixels.w}x${scenePixels.h}`,
    );
    check(
      'frame is drawn, not a flat fill',
      scenePixels.spread > 30,
      `channel spread ${scenePixels.spread} across ${scenePixels.samples} sampled pixels`,
    );
  }

  // The tune panel: editing a rate must reach the model, not just the DOM.
  const tuneResult = await evaluate(`(() => {
    const { tune, flight } = globalThis.__fpvsim;
    const panel = document.querySelector('#tune-panel');
    const inputs = [...panel.querySelectorAll('input[type=number]')];
    if (inputs.length < 9) return { ok: false, reason: inputs.length + ' inputs' };
    const before = flight.sim.rates.rate[0];
    inputs[1].value = '40';
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    const after = flight.sim.rates.rate[0];
    const curve = panel.querySelector('.tune-curveline');
    const stored = localStorage.getItem('fpvsim.tune.v1');
    return {
      ok: true,
      before, after,
      curveDrawn: !!curve && (curve.getAttribute('d') || '').length > 50,
      persisted: !!stored && stored.includes('"rate"'),
      readouts: [...panel.querySelectorAll('.tune-val')].map((e) => e.textContent),
    };
  })()`);

  check(
    'tune panel present and wired',
    tuneResult.ok === true,
    tuneResult.ok ? 'nine rate fields' : `no — ${tuneResult.reason}`,
  );
  if (tuneResult.ok) {
    check(
      'editing a rate reaches the flight model',
      tuneResult.before !== tuneResult.after && tuneResult.after === 40,
      `sim rates.rate[0] ${tuneResult.before} -> ${tuneResult.after}`,
    );
    check('rate curve is drawn', tuneResult.curveDrawn === true, 'path has geometry');
    check('tune persists to localStorage', tuneResult.persisted === true, 'stored');
    check(
      'centre and max readouts computed',
      tuneResult.readouts.every((t) => /°\/s$/.test(t ?? '')),
      tuneResult.readouts.join(' '),
    );
  }

  // Let it run a while longer to catch anything that only shows up over time.
  await sleep(2000);

  if (process.env.SCREENSHOT) {
    // Put the quad somewhere worth photographing: airborne on the gate run,
    // looking down the line.
    await evaluate(`(() => {
      const { scene, flight } = globalThis.__fpvsim;
      if (scene.available) {
        const t = (scene.constructor, null);
        scene.loadTrack(scene.track);
      }
      flight.sim.reset(0);
      flight.sim.pos.x = -34; flight.sim.pos.y = 1.5; flight.sim.pos.z = -2.2;
      flight.sim.onGround = false;
      scene.render();
    })()`);
    await evaluate(`document.querySelector('#${process.env.SHOT_SECTION || 'scene'}').scrollIntoView()`);
    await sleep(400);
    const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' }, sessionId);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.SCREENSHOT, Buffer.from(shot.data, 'base64'));
    console.log(`  screenshot written to ${process.env.SCREENSHOT}`);
  }

  check('no page errors', problems.length === 0, problems.length === 0 ? 'clean' : `${problems.length} problem(s)`);
  if (problems.length) for (const p of problems) console.log(`      ${p}`);
  if (consoleLines.length) {
    console.log(`  console output (${consoleLines.length} lines):`);
    for (const l of consoleLines.slice(0, 12)) console.log(`      ${l}`);
  }

  console.log(failed === 0 ? '\n\x1b[1mBrowser check passed\x1b[0m' : `\n\x1b[1m${failed} check(s) failed\x1b[0m`);
  cleanup(failed === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error('browser-check failed:', e.message);
  cleanup(2);
});
