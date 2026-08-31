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
  // Fail on an empty port rather than reporting four puzzling check failures.
  // The default target used to be a permanent dev server; it is now whatever
  // happens to be on 5180, which may be nothing, or a tunnel to somewhere else.
  try {
    const probe = await fetch(URL_TO_CHECK, { redirect: 'manual' });
    if (!probe.ok && probe.status >= 500) throw new Error(`HTTP ${probe.status}`);
  } catch (e) {
    console.error(
      `\nnothing usable at ${URL_TO_CHECK} — ${e instanceof Error ? e.message : e}` +
        `\nstart one with \`npm run dev\`, or pass a URL: browser-check.mjs <url>\n`,
    );
    cleanup(2);
  }

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
  let warned = 0;
  const warn = (name, condition, detail) => {
    if (condition) {
      console.log(`  \x1b[32mPASS\x1b[0m ${name} — ${detail}`);
    } else {
      warned++;
      console.log(`  \x1b[33mWARN\x1b[0m ${name} — ${detail}`);
    }
  };
  const check = (name, condition, detail) => {
    if (condition) {
      console.log(`  \x1b[32mPASS\x1b[0m ${name} — ${detail}`);
    } else {
      failed++;
      console.log(`  \x1b[31mFAIL\x1b[0m ${name} — ${detail}`);
    }
  };

  console.log(`\n\x1b[1mBrowser check: ${URL_TO_CHECK}\x1b[0m`);

  // Which mode we are in decides how isolation is judged. Against our own dev
  // server it is a hard requirement and a regression if lost. Against an
  // arbitrary deployed URL it is a property of that host's configuration: the
  // page degrades on purpose and still flies, so it is a warning about
  // deployment quality rather than a failure of the build.
  const hasHandle = await evaluate('!!globalThis.__fpvsim');
  const judge = hasHandle ? check : warn;

  const isolated = await evaluate('globalThis.crossOriginIsolated === true');
  judge(
    'cross-origin isolated',
    isolated,
    isolated
      ? 'yes — SharedArrayBuffer available'
      : 'no — the host is not sending COOP/COEP, so the ticker falls back',
  );

  const backend = await evaluate(
    `document.querySelectorAll('#status-pills .pill')[1]?.textContent ?? '(none)'`,
  );
  judge('ticker backend', /atomics/.test(backend), backend);

  const hasPanel = await evaluate(`!!document.querySelector('#flight-panel .fl-grid') && !!document.querySelector('#flight-live .fl-nums')`);
  check('flight panels rendered', hasPanel, hasPanel ? 'live and diagnostic hosts both present' : 'missing');

  // The deep checks reach into the page through a debug handle that only exists
  // in a dev build, on purpose — a production bundle should not carry a
  // load-bearing API into the world. Against a built artefact this degrades to
  // a smoke test of the things that can be seen from outside, which is still
  // worth having: it is the artefact you would actually hand to someone.
  if (!hasHandle) {
    console.log(`  \x1b[33mnote\x1b[0m  no debug handle — production build, running smoke checks only`);

    // A trustworthy origin is the precondition for everything else: without it
    // the browser ignores COOP/COEP no matter what the host sends, and hides
    // the Gamepad API, so the page can be looked at but not flown.
    const ctx = await evaluate(`(() => ({
      secure: globalThis.isSecureContext === true,
      gamepads: typeof navigator.getGamepads === 'function',
    }))()`);
    warn(
      'trustworthy origin',
      ctx.secure,
      ctx.secure
        ? 'yes — isolation honoured and radios visible'
        : 'no — plain http to a non-localhost origin, so COOP/COEP are ignored and ' +
          `the Gamepad API is ${ctx.gamepads ? 'present but inert' : 'hidden'}. Look, do not fly.`,
    );

    const notice = await evaluate(`(() => {
      const n = document.querySelector('#notice');
      return { hidden: n?.hidden !== false, text: (n?.textContent || '').slice(0, 90) };
    })()`);
    check(
      'degraded-state notice matches the environment',
      isolated ? notice.hidden === true : notice.hidden === false,
      isolated ? 'isolated, so no notice shown' : `notice shown: "${notice.text}"`,
    );
    if (!ctx.secure) {
      check(
        'and blames the origin rather than the host',
        /http|https/i.test(notice.text ?? ''),
        `"${(notice.text ?? '').slice(0, 80)}…"`,
      );
    }

    // Read inside an animation frame. The drawing buffer is cleared at
    // composite, so a readback outside the frame the app drew in sees nothing —
    // which looks exactly like a renderer that is not working.
    const canvas = await evaluate(`new Promise((resolve) => requestAnimationFrame(() => {
      const c = document.querySelector('canvas');
      if (!c || !c.width) return resolve({ ok: false });
      const off = document.createElement('canvas');
      off.width = c.width; off.height = c.height;
      const ctx = off.getContext('2d');
      ctx.drawImage(c, 0, 0);
      const d = ctx.getImageData(0, 0, off.width, off.height).data;
      let min = [255,255,255], max = [0,0,0];
      for (let i = 0; i < d.length; i += 4 * 97) {
        for (let k = 0; k < 3; k++) {
          if (d[i+k] < min[k]) min[k] = d[i+k];
          if (d[i+k] > max[k]) max[k] = d[i+k];
        }
      }
      resolve({ ok: true, w: c.width, spread: Math.max(max[0]-min[0], max[1]-min[1], max[2]-min[2]) });
    }))`);
    check(
      'the scene draws in the built page',
      canvas.ok === true && canvas.spread > 30,
      canvas.ok ? `${canvas.w}px wide, channel spread ${canvas.spread}` : 'no canvas',
    );

    await sleep(1500);
    // On an untrustworthy origin Chrome logs an error saying it ignored
    // COOP. That is the browser correctly describing the environment, and the
    // page already says the same thing in words — counting it as a defect would
    // mean this check can never pass over plain http, which is a real way to
    // deploy even if it is not a good one.
    const expected = (m) =>
      !ctx.secure && /Cross-Origin-(Opener|Embedder)-Policy/i.test(m) && /untrustworthy|https/i.test(m);
    const real = problems.filter((m) => !expected(m));
    const excused = problems.length - real.length;
    check(
      'no page errors',
      real.length === 0,
      real.length === 0
        ? excused > 0
          ? `clean (${excused} expected on an insecure origin)`
          : 'clean'
        : `${real.length} problem(s)`,
    );
    for (const p of real) console.log(`      ${p}`);
    const tail = warned > 0 ? ` (${warned} warning${warned === 1 ? '' : 's'})` : '';
    console.log(
      failed === 0
        ? `\n\x1b[1mSmoke check passed${tail}\x1b[0m`
        : `\n\x1b[1m${failed} check(s) failed${tail}\x1b[0m`,
    );
    cleanup(failed === 0 ? 0 : 1);
    return;
  }

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
    // The page rescans for devices once a second when none is connected, and
    // on this machine there is a real radio plugged in — so a single select(-1)
    // followed by a fixed wait races that timer and occasionally reads as still
    // connected. Deselect repeatedly until the disconnected state is observed.
    let out = null;
    for (let i = 0; i < 25 && !out; i++) {
      poller.select(-1);
      await new Promise((r) => setTimeout(r, 20));
      if (!poller.connected) {
        out = { connected: false, throttle: flight.lastInputThrottle };
      }
    }
    poller.select(saved);
    return out ?? { connected: poller.connected, throttle: flight.lastInputThrottle };
  })()`);
  check(
    'losing the link reads as no throttle',
    noLink.connected === false && noLink.throttle === 0,
    `connected ${noLink.connected}, throttle ${noLink.throttle}`,
  );

  // The insecure-context case: Chrome does not expose the Gamepad API over
  // plain http, so the property is simply absent. poll() runs a thousand times
  // a second, and unguarded it threw every one of them.
  const noApi = await evaluate(`(async () => {
    const { poller } = globalThis.__fpvsim;
    const real = navigator.getGamepads;
    Object.defineProperty(navigator, 'getGamepads', { value: undefined, configurable: true });
    const before = globalThis.__fpvsimErrors ?? 0;
    await new Promise((r) => setTimeout(r, 250));
    const connected = poller.connected;
    const notice = document.querySelector('#notice');
    const shown = notice && notice.hidden === false ? notice.textContent : '';
    Object.defineProperty(navigator, 'getGamepads', { value: real, configurable: true });
    return { connected, shown, polls: poller.polls };
  })()`);
  check(
    'a missing Gamepad API does not throw on the hot path',
    problems.length === 0 && noApi.connected === false,
    `${noApi.polls.toLocaleString()} polls, no device, no exceptions`,
  );
  check(
    'and the page explains it needs HTTPS',
    /https/i.test(noApi.shown ?? ''),
    `"${(noApi.shown ?? '').slice(0, 70)}…"`,
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
    // The recorder moved to Settings -> Diagnostics: it is a tool you set up
    // deliberately, not something to read while racing.
    const panel = document.querySelector('#recorder-panel');
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
    const armBtn = [...document.querySelectorAll('#flight-live button')]
      .find((b) => b.textContent === 'Arm');
    armBtn?.click();
    const armedWhileCrashed = sim.armed;
    const refusalText = document.querySelector('#flight-live .dim')?.textContent ?? '';

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
    const afterResetText = document.querySelector('#flight-live .dim')?.textContent ?? '';
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

  // The quad instrument. Same pixel-readback technique as the scene check, and
  // for the same reason: a WebGL view that silently draws nothing looks exactly
  // like one that works.
  const quad = await evaluate(`new Promise((resolve) => {
    // The instruments tab has to be visible or its canvas has no layout size,
    // and a canvas with no size draws nothing — which would look exactly like a
    // broken renderer.
    globalThis.__fpvsim.tabs.show('instruments');
    requestAnimationFrame(() => {
    const { flight } = globalThis.__fpvsim;
    if (!flight.quadView) return resolve({ ok: false, reason: 'no WebGL' });
    // Stick-driven now, not attitude-driven: this is the mapping check.
    flight.renderQuad({ throttle: 0.6, roll: 0.7, pitch: -0.4, yaw: 0.2 }, [400, -220, 90], performance.now());
    const c = flight.quadCanvas ?? document.querySelector('.fl-quad');
    const off = document.createElement('canvas');
    off.width = c.width; off.height = c.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, off.width, off.height).data;
    let min = [255,255,255], max = [0,0,0];
    for (let i = 0; i < d.length; i += 4 * 31) {
      for (let k = 0; k < 3; k++) {
        if (d[i+k] < min[k]) min[k] = d[i+k];
        if (d[i+k] > max[k]) max[k] = d[i+k];
      }
    }
    resolve({ ok: true, w: c.width, spread: Math.max(max[0]-min[0], max[1]-min[1], max[2]-min[2]) });
    });
  })`);
  const quadSticks = await evaluate(`(() => {
    const { flight } = globalThis.__fpvsim;
    if (!flight.quadView) return { ok: false };
    const shot = (cmd, rate) => {
      flight.renderQuad(cmd, rate ?? [cmd.roll * 500, cmd.pitch * 500, cmd.yaw * 500], performance.now());
      const c = flight.quadCanvas;
      const off = document.createElement('canvas');
      off.width = c.width; off.height = c.height;
      off.getContext('2d').drawImage(c, 0, 0);
      return off.toDataURL().length;
    };
    // Acro, so hold-and-release must NOT return to level. Read the model
    // matrix rather than pixels: it is the thing under test, and it does not
    // wobble with prop rotation.
    const col = () => [...flight.quadView.modelMatrix].slice(0, 3).map((v) => +v.toFixed(3));
    flight.quadView.level();
    const start = col();
    for (let i = 0; i < 40; i++) shot({ throttle: 0, roll: 1, pitch: 0, yaw: 0 });
    const rolled = col();
    for (let i = 0; i < 40; i++) shot({ throttle: 0, roll: 0, pitch: 0, yaw: 0 });
    const held = col();
    flight.quadView.level();
    const levelled = col();

    // Pitch forward has to drop the nose. The model's forward axis is -z, so
    // its y component going negative is the nose going down.
    flight.quadView.level();
    for (let i = 0; i < 40; i++) shot({ throttle: 0, roll: 0, pitch: 1, yaw: 0 });
    const fwd = [...flight.quadView.modelMatrix].slice(8, 11).map((v) => +v.toFixed(3));
    // Roll right must drop the right wingtip. The model's right axis is +x, so
    // its y component going negative is that wingtip going down.
    flight.quadView.level();
    for (let i = 0; i < 40; i++) shot({ throttle: 0, roll: 1, pitch: 0, yaw: 0 });
    const rightY = +[...flight.quadView.modelMatrix][1].toFixed(3);

    // Yaw right must swing the nose toward +x.
    flight.quadView.level();
    for (let i = 0; i < 40; i++) shot({ throttle: 0, roll: 0, pitch: 0, yaw: 1 });
    const noseX = -[...flight.quadView.modelMatrix][8];

    flight.quadView.level();
    return { ok: true, start, rolled, held, levelled, noseY: -fwd[1], rightY, noseX };
  })()`);
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.02);
  check(
    'the stick check integrates like acro, and holds when centred',
    quadSticks.ok && !near(quadSticks.start, quadSticks.rolled) &&
      near(quadSticks.rolled, quadSticks.held) && near(quadSticks.levelled, quadSticks.start),
    quadSticks.ok
      ? `rolled to [${quadSticks.rolled}], stayed there when centred, Level restored it`
      : 'no WebGL',
  );
  check(
    'pitch forward drops the nose',
    quadSticks.ok && quadSticks.noseY < -0.2,
    `nose y ${quadSticks.noseY} after holding forward pitch (negative is down)`,
  );
  check(
    'roll right drops the right wingtip',
    quadSticks.ok && quadSticks.rightY < -0.2,
    `right-axis y ${quadSticks.rightY} (negative is down)`,
  );
  // The rate curve drives it, so a faster rate turns further in the same time.
  const rateDriven = await evaluate(`(() => {
    const { flight } = globalThis.__fpvsim;
    if (!flight.quadView) return { ok: false };
    // Short window on purpose: 600 deg/s over half a second is 288 degrees,
    // which sails past vertical and makes the tilt non-monotonic. Six frames
    // keeps both cases well inside a quarter turn.
    const turn = (dps) => {
      flight.quadView.level();
      const t0 = performance.now();
      flight.renderQuad({ throttle: 0, roll: 1, pitch: 0, yaw: 0 }, [dps, 0, 0], t0);
      for (let i = 1; i <= 6; i++) {
        flight.renderQuad({ throttle: 0, roll: 1, pitch: 0, yaw: 0 }, [dps, 0, 0], t0 + i * 16);
      }
      return Math.abs([...flight.quadView.modelMatrix][1]);
    };
    const slow = turn(100);
    const fast = turn(600);
    flight.quadView.level();
    return { ok: true, slow, fast };
  })()`);
  check(
    'a faster rate curve turns the model further',
    rateDriven.ok && rateDriven.fast > rateDriven.slow * 2,
    rateDriven.ok
      ? `100 deg/s tilts ${rateDriven.slow.toFixed(3)}, 600 deg/s tilts ${rateDriven.fast.toFixed(3)}`
      : 'no WebGL',
  );

  check(
    'yaw right swings the nose right',
    quadSticks.ok && quadSticks.noseX > 0.2,
    `nose x ${quadSticks.noseX.toFixed(3)}`,
  );

  check(
    'the quad instrument draws an airframe',
    quad.ok === true && quad.spread > 30,
    quad.ok ? `${quad.w}px wide, channel spread ${quad.spread}` : `no — ${quad.reason}`,
  );

  // The race, end to end through the real page: select the course, start it,
  // fly the checkpoints, and read the results table out of the DOM.
  const race = await evaluate(`(async () => {
    const { racePanel, scene, flight, tabs } = globalThis.__fpvsim;
    tabs.show('fly');
    const course = racePanel.race.course;
    scene.loadTrack(scene.constructor === undefined ? null : scene.track);
    racePanel.race.laps = 3;
    racePanel.race.start(0);

    // Drive the checkpoints directly. The flight model is tested elsewhere;
    // this is about the sequencing and the timing reaching the page.
    const dt = 0.001;
    let n = course.start.north, e = course.start.east, u = 1.5;
    const go = (tn, te, tu) => {
      const d = Math.hypot(tn - n, te - e, tu - u);
      const steps = Math.max(1, Math.round(d / 14 / dt));
      const n0 = n, e0 = e, u0 = u;
      for (let i = 1; i <= steps; i++) {
        const f = i / steps;
        n = n0 + (tn - n0) * f; e = e0 + (te - e0) * f; u = u0 + (tu - u0) * f;
        racePanel.race.setDt(dt);
        racePanel.race.step(n, e, u, dt);
      }
    };
    racePanel.race.setDt(dt); racePanel.race.step(n, e, u, dt);
    for (let lap = 0; lap < 3; lap++) {
      for (const cp of course.checkpoints) {
        if (cp.kind === 'gate') {
          go(cp.north - cp.dirN * 3, cp.east - cp.dirE * 3, cp.up);
          go(cp.north + cp.dirN * 3, cp.east + cp.dirE * 3, cp.up);
        } else {
          const aN = -cp.dirE * cp.passWidth * 0.5 * cp.side;
          const aE = cp.dirN * cp.passWidth * 0.5 * cp.side;
          go(cp.north - cp.dirN * 6 + aN, cp.east - cp.dirE * 6 + aE, 4);
          go(cp.north + cp.dirN * 6 + aN, cp.east + cp.dirE * 6 + aE, 4);
        }
      }
    }
    racePanel.render();
    const table = document.querySelector('#race-panel .race-table');
    return {
      state: racePanel.race.state,
      laps: racePanel.race.completed.length,
      rows: table ? table.querySelectorAll('tr').length : 0,
      cols: table ? table.querySelectorAll('tr')[0].children.length : 0,
      checkpoints: course.checkpoints.length,
      summary: [...document.querySelectorAll('#race-panel .race-summary .fl-num-val')].map((x) => x.textContent),
    };
  })()`);
  check(
    'a race runs to completion through the page',
    race.state === 'finished' && race.laps === 3,
    `${race.laps} laps, state ${race.state}`,
  );
  check(
    'the results table has a column per checkpoint',
    race.cols === race.checkpoints + 2 && race.rows === 4,
    `${race.rows - 1} lap rows, ${race.cols} columns for ${race.checkpoints} checkpoints plus lap and total`,
  );
  check(
    'and reports hole shot, best lap, best three and total',
    race.summary.length === 4 && race.summary.every((v) => v && v !== '—'),
    race.summary.join(' | '),
  );

  // The next-checkpoint marker must exist, change with the checkpoint, and go
  // away when the race ends — a stale marker pointing at gate 3 after the
  // finish is worse than none.
  const marker = await evaluate(`(() => {
    const { scene, racePanel } = globalThis.__fpvsim;
    if (!scene.renderer) return { ok: false };
    const r = scene.renderer;
    const course = racePanel.race.course;
    const count = () => r.markerTriangleCount;
    r.setNextCheckpoint(null);
    const none = count();
    r.setNextCheckpoint(course.checkpoints[0]);
    const gate = count();
    const flag = course.checkpoints.find((c) => c.kind === 'flag');
    r.setNextCheckpoint(flag);
    const ring = count();
    r.setNextCheckpoint(null);
    return { ok: true, none, gate, ring, cleared: count() };
  })()`);
  // Green from the side you take it from, red from the other. Rendered rather
  // than asserted on a variable: the tint is a draw-time uniform, so the only
  // honest check is what comes out.
  const tint = await evaluate(`new Promise((resolve) => {
    const { scene, flight, racePanel } = globalThis.__fpvsim;
    if (!scene.renderer) return resolve({ ok: false });
    const gate = racePanel.race.course.checkpoints.find((c) => c.kind === 'gate');
    const look = (fromBehind) => {
      // Set the marker inside the frame, immediately before drawing. The page's
      // own animation loop clears it every frame while no race is running, so
      // setting it earlier is a race the page usually wins.
      scene.renderer.setNextCheckpoint(gate);
      const s = fromBehind ? -8 : 8;
      flight.sim.reset(0);
      flight.sim.pos.x = gate.north + gate.dirN * s;
      flight.sim.pos.y = gate.east + gate.dirE * s;
      flight.sim.pos.z = -gate.up;
      flight.sim.onGround = false;
      scene.render();
      const c = scene.canvas;
      const off = document.createElement('canvas');
      off.width = c.width; off.height = c.height;
      off.getContext('2d').drawImage(c, 0, 0);
      const d = off.getContext('2d').getImageData(0, 0, off.width, off.height).data;
      // The marker is the only saturated green or red in the frame.
      let g = 0, r = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i+1] > 170 && d[i] < 110 && d[i+2] < 130) g++;
        if (d[i] > 170 && d[i+1] < 110 && d[i+2] < 110) r++;
      }
      return { g, r };
    };
    requestAnimationFrame(() => {
      const behind = look(true);
      const infront = look(false);
      scene.renderer.setNextCheckpoint(null);
      resolve({ ok: true, behind, infront });
    });
  })`);
  check(
    'the marker is green from the correct side and red from the wrong one',
    tint.ok && tint.behind.g > tint.behind.r && tint.infront.r > tint.infront.g,
    tint.ok
      ? `approaching: ${tint.behind.g} green vs ${tint.behind.r} red; past it: ${tint.infront.r} red vs ${tint.infront.g} green`
      : 'no renderer',
  );

  check(
    'the next-checkpoint marker is drawn on the checkpoint',
    marker.ok && marker.none === 0 && marker.gate > 0 && marker.ring > 0 &&
      marker.ring !== marker.gate && marker.cleared === 0,
    marker.ok
      ? `gate outline ${marker.gate} indices, flag arrow ${marker.ring}, cleared to ${marker.cleared}`
      : 'no renderer',
  );

  // A race must be impossible on a map with no gates, and switching away from
  // the race map must clear the marker — otherwise checkpoint outlines hang in
  // mid-air over ground that has nothing on it.
  const mapBound = await evaluate(`(async () => {
    const { scene, racePanel } = globalThis.__fpvsim;
    const tracks = [...document.querySelectorAll('#scene-view select')][0];
    const race = scene.renderer;
    const pick = (name) => {
      const opt = [...tracks.options].find((o) => o.textContent === name);
      tracks.value = opt.value;
      tracks.dispatchEvent(new Event('change', { bubbles: true }));
    };

    pick('Race — six gates');
    const onRace = { disabled: racePanel.startBtnDisabled, hasCourse: !!scene.track.course };
    racePanel.race.start(0);
    racePanel.race.setDt(0.001);
    racePanel.race.step(-34, 0, 1.5, 0.001);
    scene.setNextCheckpoint(racePanel.race.activeCheckpoint);
    const markerOnRace = race.markerTriangleCount;

    pick('Open field');
    const btn = [...document.querySelectorAll('#race-panel button')][0];
    const onField = {
      // Disabled has to be visible, not just enforced: a live-looking button
      // that silently does nothing is worse than one that is obviously off.
      faded: parseFloat(getComputedStyle(btn).opacity) < 0.7,
      hintShown: (document.querySelector('#race-panel .dim')?.textContent || '').length > 0,
      disabled: racePanel.startBtnDisabled,
      hasCourse: !!scene.track.course,
      raceState: racePanel.race.state,
      marker: race.markerTriangleCount,
    };
    pick('Race — six gates');
    return { onRace, markerOnRace, onField, saved: JSON.parse(localStorage.getItem('fpvsim.scene.v1') || '{}') };
  })()`);
  check(
    'a race can only start on a map that has a course',
    mapBound.onRace.hasCourse && !mapBound.onRace.disabled &&
      !mapBound.onField.hasCourse && mapBound.onField.disabled,
    `race map: enabled; open field: ${mapBound.onField.disabled ? 'disabled' : 'STILL ENABLED'}`,
  );
  check(
    'and the disabled button looks disabled, with a reason beside it',
    mapBound.onField.faded && mapBound.onField.hintShown,
    `faded: ${mapBound.onField.faded}, reason shown: ${mapBound.onField.hintShown}`,
  );
  check(
    'switching away from the race map stops it and clears the marker',
    mapBound.markerOnRace > 0 && mapBound.onField.marker === 0 && mapBound.onField.raceState === 'idle',
    `marker ${mapBound.markerOnRace} -> ${mapBound.onField.marker}, race ${mapBound.onField.raceState}`,
  );
  check(
    'the chosen map is stored by name, not by a position in a list',
    typeof mapBound.saved.trackName === 'string' && mapBound.saved.track === undefined,
    `stored "${mapBound.saved.trackName}"`,
  );

  // A crash mid-race must put the quad back where it went in, whatever the
  // reset selector says — sending a racer to the start line ends the race in
  // practice, since the remaining checkpoints are behind them.
  const raceReset = await evaluate(`(() => {
    const { scene, flight, racePanel } = globalThis.__fpvsim;
    scene.resetMode = 'start';
    racePanel.race.reset();

    // Outside a race the selector is honoured.
    flight.sim.reset(0);
    flight.sim.pos.x = 40; flight.sim.pos.y = 12;
    scene.forceInPlace = false;
    scene.reset();
    const idle = { north: flight.sim.pos.x, east: flight.sim.pos.y };

    // During one it is not.
    racePanel.race.start(0);
    flight.sim.pos.x = 40; flight.sim.pos.y = 12;
    scene.forceInPlace = true;
    scene.reset();
    const racing = { north: flight.sim.pos.x, east: flight.sim.pos.y };
    racePanel.race.reset();
    scene.forceInPlace = false;
    scene.resetMode = 'inPlace';
    return { idle, racing, start: scene.track.start };
  })()`);
  check(
    'outside a race, "reset to start line" is honoured',
    Math.abs(raceReset.idle.north - raceReset.start.north) < 0.1,
    `back to ${raceReset.idle.north.toFixed(1)} north, start is ${raceReset.start.north}`,
  );
  check(
    'but a crash mid-race respawns where it happened, so the race can continue',
    Math.hypot(raceReset.racing.north - 40, raceReset.racing.east - 12) < 3,
    `respawned at ${raceReset.racing.north.toFixed(1)}, ${raceReset.racing.east.toFixed(1)} — crashed at 40, 12`,
  );

  // Crashing mid-race must recover on its own. Without it the quad lies there
  // with the clock running while the pilot reaches for a key, which ends the
  // race in practice.
  const autoRecover = await evaluate(`(async () => {
    const { scene, flight, racePanel, tabs } = globalThis.__fpvsim;
    tabs.show('fly');
    racePanel.race.reset();
    racePanel.race.laps = 3;
    racePanel.race.start(0);
    await new Promise((r) => setTimeout(r, 60));

    // Crash it hard, at height, with the throttle up — the case that used to
    // respawn disarmed and drop.
    flight.sim.armed = true;
    // Open ground, well away from the course. Crashing beside a gate post meant
    // the quad respawned a metre from it and sometimes flew straight back into
    // it at half throttle — which is real behaviour, but not what is under test.
    flight.sim.pos.x = -30; flight.sim.pos.y = 22; flight.sim.pos.z = -4;
    flight.sim.onGround = false;
    // Driven into the ground rather than dropped: at half throttle it would
    // climb away instead. The throttle stays up, which is the case that used to
    // respawn disarmed and drop a second later.
    flight.sim.vel.z = 30;
    for (let i = 0; i < 3000 && !flight.sim.crashed; i++) {
      flight.step({ throttle: 0.5, roll: 0, pitch: 0, yaw: 0 }, true);
    }
    const crashed = flight.sim.crashed;
    const where = { north: flight.sim.pos.x, east: flight.sim.pos.y };

    // Let the tick drive the recovery, and read the state at the moment it
    // happens. Waiting a fixed time instead races: the quad flies on at half
    // throttle after respawning and may well hit something else, so a later
    // reading describes the *second* crash rather than the recovery.
    let after = null;
    for (let i = 0; i < 120 && !after; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (!flight.sim.crashed) {
        after = {
          north: flight.sim.pos.x,
          east: flight.sim.pos.y,
          armed: flight.sim.armed,
          armedAtCrash: flight.sim.armedAtCrash,
          alt: -flight.sim.pos.z,
          connected: globalThis.__fpvsim.poller.connected,
          lastThrottle: flight.lastInputThrottle,
        };
      }
    }
    return { crashed, where, after, lapVoid: racePanel.race.lapWasInvalidated };
  })()`);
  check(
    'a mid-race crash recovers on its own',
    autoRecover.crashed && autoRecover.after !== null,
    autoRecover.crashed
      ? autoRecover.after
        ? 'crashed, then cleared without a keypress'
        : 'crashed and stayed crashed'
      : 'could not get it to crash',
  );
  const moved = autoRecover.after
    ? Math.hypot(
        autoRecover.after.north - autoRecover.where.north,
        autoRecover.after.east - autoRecover.where.east,
      )
    : NaN;
  // Armed unless the radio vanished. Headless here can see a real Radiomaster
  // and its availability flickers, and the failsafe disarming on a lost link is
  // correct behaviour — so asserting "always armed" would be asserting that the
  // failsafe does not work.
  const linkHeld = autoRecover.after?.connected === true;
  check(
    'and comes back armed, near where it went in',
    moved < 4 && (linkHeld ? autoRecover.after?.armed === true : autoRecover.after?.armed === false),
    linkHeld
      ? `respawned ${moved.toFixed(1)} m from the wreck, armed`
      : `respawned ${moved.toFixed(1)} m from the wreck; the radio dropped, so the failsafe ` +
        `disarmed it — which is the failsafe working, not a recovery failure`,
  );
  check(
    'and the lap it happened in is void',
    autoRecover.lapVoid === true,
    'the race is finishable, not cheaper',
  );

  // The reset controls mean nothing during a race — the mode is forced in place
  // and "to start line" would drop the pilot behind every remaining checkpoint
  // with the clock running — so they must be visibly off, not merely inert.
  const raceLocks = await evaluate(`(async () => {
    const { racePanel, scene, tabs } = globalThis.__fpvsim;
    tabs.show('fly');
    const sel = [...document.querySelectorAll('#scene-view select')].pop();
    const toStart = [...document.querySelectorAll('#scene-view button')]
      .find((b) => b.textContent === 'To start line');
    racePanel.race.reset();
    scene.setRacing(false);
    const before = { sel: sel.disabled, btn: toStart.disabled };

    racePanel.race.start(3);
    await new Promise((r) => setTimeout(r, 120));
    const during = {
      sel: sel.disabled,
      btn: toStart.disabled,
      faded: parseFloat(getComputedStyle(toStart).opacity) < 0.7,
    };

    racePanel.race.reset();
    await new Promise((r) => setTimeout(r, 120));
    const after = { sel: sel.disabled, btn: toStart.disabled };
    return { before, during, after };
  })()`);
  check(
    'the reset controls are off during a race and on either side of it',
    !raceLocks.before.sel && !raceLocks.before.btn &&
      raceLocks.during.sel && raceLocks.during.btn && raceLocks.during.faded &&
      !raceLocks.after.sel && !raceLocks.after.btn,
    `before: enabled, during: disabled and faded, after: enabled`,
  );

  // Tabs: the right panel shows, and the physics does not stop when the flying
  // tab is hidden — that last one matters, because a pilot ducking into
  // Settings mid-flight must not have the quad freeze and drop.
  const tabState = await evaluate(`(async () => {
    const { tabs, flight } = globalThis.__fpvsim;
    const shown = (id) => !document.getElementById('panel-' + id).hidden;
    tabs.show('settings');
    const onSettings = { settings: shown('settings'), fly: shown('fly'), instruments: shown('instruments') };
    const t0 = flight.sim.time;
    await new Promise((r) => setTimeout(r, 300));
    const advanced = flight.sim.time - t0;
    tabs.show('fly');
    const onFly = { fly: shown('fly'), settings: shown('settings') };
    const stored = localStorage.getItem('fpvsim.tab.v1');
    return { onSettings, onFly, advanced, stored };
  })()`);
  check(
    'switching tabs shows exactly one panel',
    tabState.onSettings.settings && !tabState.onSettings.fly && !tabState.onSettings.instruments &&
      tabState.onFly.fly && !tabState.onFly.settings,
    'settings, then fly',
  );
  check(
    'the physics keeps running while the flying tab is hidden',
    tabState.advanced > 0.2,
    `${tabState.advanced.toFixed(3)} s of simulated time in 0.3 s on the settings tab`,
  );
  check('the active tab is remembered', tabState.stored === 'fly', `stored "${tabState.stored}"`);

  // Sticks follow the configured mode, and the PID panel reaches the model.
  const overlay = await evaluate(`(() => {
    const { scene, tune, flight } = globalThis.__fpvsim;
    scene.updateSticks({ throttle: 1, roll: 0, pitch: 0, yaw: -1 }, 2);
    const dots = [...scene.sticks.root.querySelectorAll('.stick-dot')];
    const left = { cx: +dots[0].getAttribute('cx'), cy: +dots[0].getAttribute('cy') };

    const pidInput = document.querySelector('#pid-panel input[type=number]');
    const before = flight.sim.controller.profile.roll.p;
    pidInput.value = '61';
    pidInput.dispatchEvent(new Event('input', { bubbles: true }));
    return { left, before, typed: 61 };
  })()`);
  check(
    'stick overlay follows throttle and yaw on mode 2',
    // Throttle full up puts the left dot at the top; yaw left puts it left.
    overlay.left.cy < 10 && overlay.left.cx < 20,
    `left gimbal at (${overlay.left.cx}, ${overlay.left.cy}) for full throttle, full left yaw`,
  );

  await sleep(1200); // the PID apply is debounced
  const pidApplied = await evaluate('globalThis.__fpvsim.flight.sim.controller.profile.roll.p');
  check(
    'a PID edit reaches the flight model, after the debounce',
    pidApplied === 61,
    `roll P ${overlay.before} -> ${pidApplied}`,
  );

  // Everything a pilot sets must survive a reload, or they re-enter it on every
  // visit and stop bothering to report anything else.
  const persisted = await evaluate(`(() => {
    const { scene } = globalThis.__fpvsim;
    const panel = document.querySelector('#scene-view');
    const nums = [...panel.querySelectorAll('input[type=number]')];
    const [fov, tilt] = nums;
    fov.value = '96'; fov.dispatchEvent(new Event('input', { bubbles: true }));
    tilt.value = '38'; tilt.dispatchEvent(new Event('input', { bubbles: true }));
    const sels = [...panel.querySelectorAll('select')];
    const modeSel = sels[sels.length - 1];
    modeSel.value = 'start'; modeSel.dispatchEvent(new Event('change', { bubbles: true }));
    const stored = JSON.parse(localStorage.getItem('fpvsim.scene.v1') || '{}');
    return {
      stored,
      live: { fov: scene.renderer?.camera.fovDeg, tilt: scene.renderer?.camera.tiltDeg, mode: scene.resetMode },
      keys: Object.keys(localStorage).filter((k) => k.startsWith('fpvsim.')).sort(),
    };
  })()`);

  check(
    'camera and reset mode reach the renderer',
    persisted.live.fov === 96 && persisted.live.tilt === 38 && persisted.live.mode === 'start',
    `fov ${persisted.live.fov}, tilt ${persisted.live.tilt}, reset ${persisted.live.mode}`,
  );
  check(
    'and are written to localStorage',
    persisted.stored.fovDeg === 96 && persisted.stored.tiltDeg === 38 && persisted.stored.resetMode === 'start',
    JSON.stringify(persisted.stored),
  );
  // The mapping key is written when a radio is actually mapped, so a fresh
  // profile that has never had one legitimately does not have it yet.
  check(
    'scene and tune are stored',
    ['fpvsim.scene.v1', 'fpvsim.tune.v1'].every((k) => persisted.keys.includes(k)),
    persisted.keys.join(', ') +
      (persisted.keys.includes('fpvsim.mappings.v1')
        ? ''
        : ' — no mapping stored yet, which is expected until a radio is mapped'),
  );

  // Let it run a while longer to catch anything that only shows up over time.
  await sleep(2000);

  if (process.env.SCREENSHOT) {
    if (process.env.SHOT_MAP) {
      await evaluate(`(() => {
        const sel = document.querySelector('#scene-view select');
        sel.value = '${process.env.SHOT_MAP}';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await sleep(400);
    }
    if (process.env.SHOT_RACE) {
      await evaluate(`(() => {
        const { racePanel, scene } = globalThis.__fpvsim;
        racePanel.race.laps = 3;
        racePanel.race.start(0);
        const dt = 0.001;
        racePanel.race.setDt(dt);
        // Cross gate 1 so the clock and the lap counter have something to show.
        const skip = Number('${process.env.SHOT_RACE}') || 1;
        // Walk the sequence forward to whichever checkpoint we want to see.
        racePanel.race.next = skip - 1;
        racePanel.race.holeShot = 1.2;
        racePanel.race.time = 12.4;
        racePanel.render();
      })()`);
      await sleep(200);
    }
    // Put the quad somewhere worth photographing. SHOT_POS is NED.
    const pos = process.env.SHOT_POS || '-14,0,-4.2';
    await evaluate(`(() => {
      const { scene, flight } = globalThis.__fpvsim;
      const p = '${pos}'.split(',').map(Number);
      flight.sim.reset(0);
      flight.sim.pos.x = p[0]; flight.sim.pos.y = p[1]; flight.sim.pos.z = p[2];
      flight.sim.onGround = false;
      // Hold it there for the shot: otherwise it falls during the capture
      // window and the frame is of a crash rather than of the thing being
      // photographed.
      globalThis.__fpvsimHold = setInterval(() => {
        flight.sim.pos.x = p[0]; flight.sim.pos.y = p[1]; flight.sim.pos.z = p[2];
        flight.sim.vel.x = flight.sim.vel.y = flight.sim.vel.z = 0;
        flight.sim.crashed = false;
        flight.sim.onGround = false;
      }, 8);
      scene.render();
    })()`);
    if (process.env.SHOT_TAB) {
      await evaluate(`globalThis.__fpvsim.tabs.show('${process.env.SHOT_TAB}')`);
      await sleep(300);
    }
    await evaluate(`document.querySelector('#${process.env.SHOT_SECTION || 'scene'}')?.scrollIntoView()`);
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
