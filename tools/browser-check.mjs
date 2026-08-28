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
    // Flight-model checks, not collision ones. The circuit has a tube directly
    // over the origin these reset to, so with scenery in place they climb into
    // it, crash, disarm and fall back — a net climb of zero and a puzzling
    // failure about the wrong subsystem.
    const scenery = sim.obstacles;
    sim.obstacles = [];
    sim.reset();
    if (!sim.arm({ throttle: 0, roll: 0, pitch: 0, yaw: 0 })) return { error: 'arm refused' };
    const start = sim.telemetry.altitude;
    for (let i = 0; i < 3000; i++) sim.step({ throttle: 0.35, roll: 0, pitch: 0, yaw: 0 });
    const climbed = sim.telemetry.altitude - start;
    for (let i = 0; i < 2000; i++) sim.step({ throttle: 0.35, roll: 0.4, pitch: 0, yaw: 0 });
    sim.obstacles = scenery;
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
  // Losing the link must read as no stick, not as whatever the axes last held.
  // A raw zero on a unipolar channel is mid-travel, so stale axes present as
  // half throttle — which is what an uncalibrated device does here, and what a
  // vanished one used to do.
  const noLink = await evaluate(`(async () => {
    const { flight, poller } = globalThis.__fpvsim;
    const saved = poller.index;
    poller.select(-1);
    await new Promise((r) => setTimeout(r, 60));
    const out = { connected: poller.connected, throttle: flight.lastInputThrottle };
    poller.select(saved);
    return out;
  })()`);
  check(
    'losing the link reads as no throttle',
    noLink.connected === false && noLink.throttle === 0,
    `connected ${noLink.connected}, throttle ${noLink.throttle}`,
  );

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
    // The field shows configurator units; the model stores Betaflight's. On the
    // default Actual curve the max-rate field is deg/s, so 400 on screen must
    // become 40 stored.
    const before = flight.sim.rates.rate[0];
    inputs[1].value = '400';
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    const after = flight.sim.rates.rate[0];
    const heads = [...panel.querySelectorAll('.tune-head')].map((e) => e.textContent);
    const curve = panel.querySelector('.tune-curveline');
    const stored = localStorage.getItem('fpvsim.tune.v1');
    return {
      ok: true,
      before, after,
      curveDrawn: !!curve && (curve.getAttribute('d') || '').length > 50,
      persisted: !!stored && stored.includes('"rate"'),
      readouts: [...panel.querySelectorAll('.tune-val')].map((e) => e.textContent),
      heads,
    };
  })()`);

  check(
    'tune panel present and wired',
    tuneResult.ok === true,
    tuneResult.ok ? 'nine rate fields' : `no — ${tuneResult.reason}`,
  );
  if (tuneResult.ok) {
    check(
      'editing a rate reaches the model, in configurator units',
      tuneResult.before !== tuneResult.after && tuneResult.after === 40,
      `typed 400 deg/s, stored ${tuneResult.after} (was ${tuneResult.before})`,
    );
    check(
      'column headings name the fields of the selected curve',
      (tuneResult.heads || []).some((h) => /Centre sens/.test(h || '')),
      (tuneResult.heads || []).filter(Boolean).join(' | '),
    );
    check('rate curve is drawn', tuneResult.curveDrawn === true, 'path has geometry');
    check('tune persists to localStorage', tuneResult.persisted === true, 'stored');
    check(
      'centre and max readouts computed',
      tuneResult.readouts.every((t) => /°\/s$/.test(t ?? '')),
      tuneResult.readouts.join(' '),
    );
  }

  // Collision, end to end: the track's volumes must reach the model, and
  // hitting one must crash it.
  const collide = await evaluate(`(() => {
    const { scene, flight } = globalThis.__fpvsim;
    const sim = flight.sim;
    const count = sim.obstacles.length;
    if (!count) return { ok: false, reason: 'no obstacles loaded from the track' };

    // Aim at the nearest gate post on the gate run and fly into it.
    const posts = sim.obstacles.filter((o) => o.kind === 'cylinder');
    const target = posts.reduce((a, b) => (Math.abs(b.north) < Math.abs(a.north) ? b : a));
    sim.reset(0);
    sim.armed = true;
    sim.pos.x = target.north - 6;
    sim.pos.y = target.east;
    sim.pos.z = -1.5;
    sim.onGround = false;
    sim.vel.x = 12;
    for (let i = 0; i < 1500 && !sim.crashed; i++) {
      sim.step({ throttle: 0.16, roll: 0, pitch: 0, yaw: 0 });
    }
    const crashedIntoPost = sim.crashed;
    const speed = sim.crashSpeed;
    // Arming must be refused while wrecked, and the button must say why.
    const armBtn = [...document.querySelectorAll('#flight-panel button')]
      .find((b) => b.textContent === 'Arm');
    armBtn?.click();
    const armedWhileCrashed = sim.armed;
    const refusalText = document.querySelector('#flight-panel .dim')?.textContent ?? '';

    // Reset must clear it, put the quad back on the start line, and — since the
    // pilot was flying when it crashed and the throttle is down — hand it back
    // armed, so recovering is one key rather than two. One step through the
    // panel's own input path first, so the throttle it reads is a known zero
    // rather than whatever an uncalibrated radio is presenting.
    const crashN = sim.pos.x;
    const crashE = sim.pos.y;
    flight.step({ throttle: 0, roll: 0, pitch: 0, yaw: 0 }, true);
    flight.reset();
    const rearmed = sim.armed;
    const afterResetText = document.querySelector('#flight-panel .dim')?.textContent ?? '';
    // And it has to survive being left alone: a respawn that drops and
    // re-crashes leaves the pilot unable to fly at all.
    for (let i = 0; i < 3000; i++) sim.step({ throttle: 0, roll: 0, pitch: 0, yaw: 0 });
    const survivedIdle = !sim.crashed && sim.armed;
    return {
      rearmed, afterResetText, survivedIdle,
      ok: true, count, crashedIntoPost, speed, armedWhileCrashed, refusalText,
      clearedByReset: !sim.crashed,
      movedFromCrash: Math.hypot(sim.pos.x - crashN, sim.pos.y - crashE),
      nearCrashSite: Math.hypot(sim.pos.x - crashN, sim.pos.y - crashE) < 3,
      respawnAlt: -sim.pos.z,
      postDistance: Math.hypot(sim.pos.x - target.north, sim.pos.y - target.east),
      clearOfPost: Math.hypot(sim.pos.x - target.north, sim.pos.y - target.east) > target.radius + 0.5,
    };
  })()`);

  check(
    'track collision volumes reach the model',
    collide.ok === true,
    collide.ok ? `${collide.count} obstacles on this map` : `no — ${collide.reason}`,
  );
  if (collide.ok) {
    check(
      'flying into a gate post crashes',
      collide.crashedIntoPost === true,
      `crashed at ${(collide.speed ?? 0).toFixed(1)} m/s`,
    );
    check(
      'a crashed quad refuses to arm, and says so',
      collide.armedWhileCrashed === false && /crash/i.test(collide.refusalText ?? ''),
      `"${collide.refusalText}"`,
    );
    check(
      'reset hands the quad back armed, so recovery is one key',
      collide.rearmed === true,
      `"${collide.afterResetText}"`,
    );
    check(
      'reset clears the crash and leaves the quad where it went in',
      collide.clearedByReset === true && collide.nearCrashSite === true,
      `crashed ${collide.clearedByReset ? 'cleared' : 'still set'}, ` +
        `respawned ${(collide.movedFromCrash ?? 0).toFixed(1)} m from the wreck ` +
        `at ${(collide.respawnAlt ?? 0).toFixed(2)} m`,
    );
    check(
      'the respawn survives being left alone at idle',
      collide.survivedIdle === true,
      collide.survivedIdle ? 'still armed and intact after 3 s' : 'it dropped and re-crashed',
    );
    check(
      'and clear of the thing it hit',
      collide.clearOfPost === true,
      `${(collide.postDistance ?? 0).toFixed(2)} m from the post it clipped`,
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
      flight.sim.pos.x = -14; flight.sim.pos.y = 0; flight.sim.pos.z = -4.2;
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
