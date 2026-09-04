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
    // Headless has no speakers, but Web Audio still runs the graph — and
    // without this the context stays suspended for want of a gesture the
    // check cannot make, so every sound assertion would pass vacuously.
    '--autoplay-policy=no-user-gesture-required',
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

  // Read off the root element rather than out of a pill. The pills used to
  // carry the ticker backend, isolation and a poll count; they were developer
  // instrumentation shown to pilots, and only the radio survived. The values
  // still go on `document.documentElement` as data attributes precisely so this
  // check keeps working against a production build, where there is no handle.
  const backend = await evaluate(`document.documentElement.dataset.ticker ?? '(none)'`);
  judge('ticker backend', /atomics/.test(backend), `ticker: ${backend}`);

  const pillCount = await evaluate(`document.querySelectorAll('#status-pills .pill').length`);
  const pillText = await evaluate(
    `document.querySelector('#status-pills .pill')?.textContent ?? '(none)'`,
  );
  check(
    'the header shows the radio and nothing else',
    pillCount === 1,
    `${pillCount} pill: "${pillText}" — isolation and the ticker are on the root element for checks, and in the banner in words when they matter`,
  );

  const brand = await evaluate(`(() => {
    const img = document.querySelector('#brand-logo');
    const link = document.querySelector('.site-footer a');
    return {
      logo: !!img && img.naturalWidth > 0,
      href: link?.getAttribute('href') ?? '',
      source: document.querySelector('.site-source a')?.getAttribute('href') ?? '',
      saysOpenSource: /open source/i.test(document.querySelector('.site-source')?.textContent ?? ''),
      // \\s, not \s: this string is a template literal on its way to the page,
      // so a single backslash is eaten here and the regex arrives as /s+/ —
      // which quietly replaced every "s" in the footer text with a space.
      footer: (document.querySelector('.site-footer')?.textContent || '').replace(/\\s+/g, ' ').trim(),
      icon: document.querySelector('link[rel=icon]')?.getAttribute('href') ?? '',
    };
  })()`);
  // The flying tab is the picture and its settings, and nothing else. Prose
  // belongs in Settings, where someone is reading rather than flying.
  const flyTab = await evaluate(`(() => {
    const { tabs, scene } = globalThis.__fpvsim;
    tabs.show('fly');
    const section = document.querySelector('#scene');
    const btn = document.querySelector('#audio-toggle');
    return {
      title: section?.querySelector('h2')?.textContent ?? '',
      hints: section.querySelectorAll(':scope > p').length,
      // The sound control sits with the map, FOV and tilt rather than above
      // the video.
      soundInControls: !!btn && scene.controls.contains(btn),
      // Ahead of the status readouts, not trailing after them.
      soundBeforeStatus: !!btn && !!(btn.compareDocumentPosition(scene.controls.lastElementChild) & Node.DOCUMENT_POSITION_FOLLOWING),
      soundBelowCanvas: !!btn &&
        !!(document.querySelector('#scene-view canvas')?.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING),
    };
  })()`);
  // A pilot's own track, end to end through the real page: paste, save, and it
  // is a map you can pick and fly.
  const custom = await evaluate(`(async () => {
    const { scene, tabs, racePanel } = globalThis.__fpvsim;
    tabs.show('settings');
    const area = document.querySelector('#track-json');
    const status = document.querySelector('#track-status');

    // Something wrong first: the errors are the feature, not the save.
    area.value = JSON.stringify({ version: 1, name: 'Bad', start: { north: 0, east: 0 }, pieces: [{ type: 'nuke', north: 0, east: 0 }] });
    document.querySelector('#track-save').click();
    const rejected = { text: status.textContent, cls: status.className };

    // Well-formed and unflyable: a pole standing in the gate. This is the check
    // that cannot be done on the JSON alone — it needs the built scene.
    area.value = JSON.stringify({
      version: 1,
      name: 'Unflyable',
      start: { north: -20, east: 0, yawDeg: 0 },
      pieces: [{ type: 'pole', north: 0, east: 0, height: 10 }],
      course: [
        { gate: { north: 0, east: 0, heading: 0 } },
        { gate: { north: 20, east: 0, heading: 0 } },
      ],
    });
    document.querySelector('#track-save').click();
    const unflyable = {
      text: status.textContent,
      saved: JSON.parse(localStorage.getItem('fpvsim.tracks.v1') || 'null')?.tracks?.length ?? 0,
    };

    area.value = JSON.stringify({
      version: 1,
      name: 'Check track',
      start: { north: -20, east: 0, yawDeg: 0 },
      laps: 2,
      pieces: [{ type: 'cube', north: 10, east: 8, storeys: 2 }],
      course: [
        { gate: { north: 0, east: 0, heading: 0 } },
        { gateRing: { north: 0, east: 0, radius: 25, count: 4 } },
      ],
    });
    document.querySelector('#track-save').click();
    await new Promise((r) => setTimeout(r, 300));

    const sel = document.querySelectorAll('#scene-view select')[0];
    const names = [...sel.options].map((o) => o.textContent);
    const listed = document.querySelectorAll('#track-list .row').length;
    const stored = JSON.parse(localStorage.getItem('fpvsim.tracks.v1') || 'null');

    // And it is really flyable: the map is loaded and its course is the one the
    // timer will run.
    const loaded = scene.track.name;
    const checkpoints = racePanel.race.course.checkpoints.length;
    const canRace = !racePanel.startBtnDisabled;

    // Clean up, so the destructive reset check later still sees what it expects.
    document.querySelector('#track-list .danger').click();
    await new Promise((r) => setTimeout(r, 200));
    const afterDelete = [...sel.options].map((o) => o.textContent);
    return {
      rejected,
      unflyable,
      names,
      listed,
      storedCount: stored?.tracks?.length ?? 0,
      loaded,
      checkpoints,
      canRace,
      afterDelete,
    };
  })()`);
  check(
    'a bad track is refused with the reasons, not swallowed',
    /unknown type/.test(custom.rejected.text ?? '') && custom.rejected.cls === 'bad',
    `"${custom.rejected.text}"`,
  );
  check(
    'a valid but unflyable track is refused, and not saved',
    /standing in the gate/.test(custom.unflyable.text ?? '') && custom.unflyable.saved === 0,
    `"${custom.unflyable.text}" — and nothing was written to storage`,
  );
  check(
    "a pilot's own track becomes a map they can pick",
    custom.names.includes('Check track') && custom.listed === 1 && custom.storedCount === 1,
    `in the map list, listed once, and stored in this browser only`,
  );
  check(
    'and it is a real course the timer will run',
    custom.loaded === 'Check track' && custom.checkpoints === 5 && custom.canRace === true,
    `${custom.checkpoints} checkpoints from 2 entries — the ring is four — and Start race is live`,
  );
  check(
    'and deleting it takes it out of the map list',
    !custom.afterDelete.includes('Check track'),
    'gone from the selector as well as from storage',
  );

  // Fullscreen, on a browser that does not have it. Safari on iPhone offers
  // element fullscreen to <video> and nothing else, so the unprefixed call
  // threw and the button did nothing — which is exactly what Gilboa saw.
  const fs = await evaluate(`(async () => {
    const { scene, tabs } = globalThis.__fpvsim;
    tabs.show('fly');
    const stage = document.querySelector('.fpv-stage');
    const proto = Object.getPrototypeOf(stage);
    const real = proto.requestFullscreen;
    const realWebkit = proto.webkitRequestFullscreen;
    // Pretend to be a phone: no element fullscreen of any kind. Both have to
    // go — Chrome keeps the webkit alias, so removing only the standard method
    // tests the prefixed path rather than the absent one.
    delete Element.prototype.requestFullscreen;
    delete Element.prototype.webkitRequestFullscreen;
    stage.requestFullscreen = undefined;
    const kind = scene.fullscreenKind;
    await scene.toggleFullscreen();
    const on = {
      pseudo: stage.classList.contains('pseudo-fullscreen'),
      locked: document.body.classList.contains('fullscreen-locked'),
      exit: !!stage.querySelector('.fpv-exit'),
      isFullscreen: scene.isFullscreen,
    };
    // And back out again, the way a pilot would: the button on the picture.
    stage.querySelector('.fpv-exit').click();
    const off = {
      pseudo: stage.classList.contains('pseudo-fullscreen'),
      locked: document.body.classList.contains('fullscreen-locked'),
      isFullscreen: scene.isFullscreen,
    };
    Element.prototype.requestFullscreen = real;
    if (realWebkit) Element.prototype.webkitRequestFullscreen = realWebkit;
    delete stage.requestFullscreen;
    return { kind, on, off, backToNative: scene.fullscreenKind };
  })()`);
  check(
    'a browser without element fullscreen still fills the screen',
    fs.kind === 'css' && fs.on.pseudo && fs.on.locked && fs.on.isFullscreen,
    'the stage is pinned to the viewport and the page behind it cannot scroll',
  );
  check(
    'and it has its own way out, since a phone has no Escape key',
    fs.on.exit === true && fs.off.pseudo === false && fs.off.locked === false && fs.off.isFullscreen === false,
    'a close button on the picture, and everything is put back',
  );
  check(
    'while a browser that has it uses the real thing',
    fs.backToNative === 'native',
    'the fallback is a fallback, not the default',
  );

  check(
    'the flying tab is the picture and its settings, with no prose',
    flyTab.title === 'Sim' && flyTab.hints === 0,
    `titled "${flyTab.title}", ${flyTab.hints} paragraphs above the view`,
  );
  check(
    'and the sound control sits with the other view settings, below the picture',
    flyTab.soundInControls === true &&
      flyTab.soundBelowCanvas === true &&
      flyTab.soundBeforeStatus === true,
    'in the same row as map, FOV, tilt and reset mode, ahead of the status readouts',
  );

  check(
    'the branding is there and the image actually loaded',
    brand.logo === true && brand.href === 'https://www.instagram.com/nacofpv',
    `logo decoded, footer reads "${brand.footer}"`,
  );
  check(
    'and it says where the source is',
    brand.source === 'https://github.com/gilboash/fpv-naive-sim' && brand.saysOpenSource === true,
    `"open source" links to ${brand.source}`,
  );

  check(
    'and the tab icon is a quad rather than a helicopter',
    /svg/.test(brand.icon) && /circle/.test(brand.icon) && !/F0%9F%9A%81/.test(brand.icon),
    'four rotors drawn as SVG — there is no quadcopter emoji',
  );

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
      return { hidden: n?.hidden !== false, text: (n?.textContent || '').slice(0, 120) };
    })()`);
    // The banner has two jobs and only one of them is about the deployment.
    // "Your throttle is not calibrated" describes the pilot's radio, and this
    // machine has a real Radiomaster plugged in whose visibility to headless
    // Chrome flickers — so an isolated page can legitimately be showing that
    // one. Judging on the text rather than on whether anything is shown is what
    // makes this check about the host again.
    const aboutTheRadio = /throttle/i.test(notice.text ?? '');
    check(
      'degraded-state notice matches the environment',
      isolated ? notice.hidden === true || aboutTheRadio : notice.hidden === false,
      isolated
        ? notice.hidden
          ? 'isolated, so no notice shown'
          : `isolated; the notice showing is about the radio, not the host: "${notice.text?.slice(0, 60)}…"`
        : `notice shown: "${notice.text}"`,
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
    // Flight-model checks, not collision ones. The freestyle map has a tube directly
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
    // A synthetic clock, not performance.now(). The model integrates against the
    // frame time, so driving it on the wall clock makes the angle depend on how
    // fast the machine drew — 40 frames turned 100 degrees here and 240 on a
    // slower run, which failed the direction check for looking like a reversal.
    // Controlling the clock makes the rotation exact.
    let clock = performance.now();
    const shot = (cmd, rate) => {
      clock += 16;
      flight.renderQuad(cmd, rate ?? [cmd.roll * 500, cmd.pitch * 500, cmd.yaw * 500], clock);
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
    for (let i = 0; i < 12; i++) shot({ throttle: 0, roll: 0, pitch: 1, yaw: 0 });
    const fwd = [...flight.quadView.modelMatrix].slice(8, 11).map((v) => +v.toFixed(3));
    // Roll right must drop the right wingtip. The model's right axis is +x, so
    // its y component going negative is that wingtip going down.
    flight.quadView.level();
    for (let i = 0; i < 12; i++) shot({ throttle: 0, roll: 1, pitch: 0, yaw: 0 });
    const rightY = +[...flight.quadView.modelMatrix][1].toFixed(3);

    // Yaw right must swing the nose toward +x.
    flight.quadView.level();
    for (let i = 0; i < 12; i++) shot({ throttle: 0, roll: 0, pitch: 0, yaw: 1 });
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
    // Already on a synthetic clock, and for the same reason as the direction
    // checks above: the angle must come from the rate, not from the machine.
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
    // Nothing to hit and nothing broken, so any invalid lap that comes out of
    // this is the timer inventing one. A lap is voided by a respawn, and the
    // page's own tick respawns automatically after a crash — so a crashed quad
    // left over from an earlier check would void every lap here and look like a
    // bug in the race rather than the leftover it is.
    flight.sim.obstacles = [];
    flight.sim.crashed = false;
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
    // Four passes for three laps: a lap closes when the aircraft comes back to
    // the start gate, so the last pass is that gate on its own.
    for (let lap = 0; lap < 4; lap++) {
      for (const cp of lap === 3 ? [course.checkpoints[0]] : course.checkpoints) {
        if (cp.kind === 'gate') {
          const du = cp.dirU ?? 0;
          go(cp.north - cp.dirN * 3, cp.east - cp.dirE * 3, cp.up - du * 3);
          go(cp.north + cp.dirN * 3, cp.east + cp.dirE * 3, cp.up + du * 3);
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
      invalid: racePanel.race.completed.filter((l) => l.invalid).length,
      struck: table ? table.querySelectorAll('tr.invalid').length : -1,
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
    'and an uninterrupted race counts every lap',
    race.invalid === 0 && race.struck === 0,
    race.invalid === 0
      ? 'no respawns, no strikethrough — a struck-out lap means a reset happened in it'
      : `${race.invalid} of ${race.laps} laps voided with nothing to hit`,
  );
  const finishOsd = await evaluate(`(async () => {
    // The OSD is drawn from the page's own 30 Hz loop, so the summary does not
    // exist in the same turn the race finished in — the checkpoints above were
    // driven synchronously. Give it frames before looking.
    for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r));
    const s = document.querySelector('.osd-summary');
    const rows = [...(s?.querySelectorAll('.osd-sum-row') || [])].map((r) =>
      r.textContent.replace(/\\s+/g, ' ').trim(),
    );
    return { shown: !!s && s.style.display !== 'none', rows, head: s?.querySelector('.osd-sum-head')?.textContent };
  })()`);
  check(
    'and the result goes up on the video, not just in the panel',
    finishOsd.shown === true &&
      finishOsd.rows.some((r) => /HOLE SHOT/.test(r)) &&
      finishOsd.rows.filter((r) => /^LAP /.test(r)).length === 3 &&
      finishOsd.rows.some((r) => /TOTAL/.test(r)) &&
      !finishOsd.rows.some((r) => /GATE/.test(r)),
    `${finishOsd.head}: ${finishOsd.rows.join(' | ')}`,
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
      // Face the gate either way. Standing past it and still looking away put
      // the gate behind the camera, so the "wrong side" frame was empty and the
      // check was passing on nothing.
      flight.sim.reset(fromBehind ? 0 : 180);
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
  // The same question for a checkpoint you drop through: above is the correct
  // side, below is not. Without the vertical term the tint sat exactly on the
  // boundary for every cube floor and told a pilot nothing.
  const tintUp = await evaluate(`(() => {
    const { scene, flight, racePanel } = globalThis.__fpvsim;
    if (!scene.renderer) return { ok: false };
    const top = racePanel.race.course.checkpoints.find((c) => c.kind === 'gate' && c.dirU === -1);
    if (!top) return { ok: false, reason: 'no drop-through checkpoint on this course' };
    const read = (upMetres) => {
      flight.sim.pos.x = top.north;
      flight.sim.pos.y = top.east;
      flight.sim.pos.z = -upMetres;
      return scene.renderer.markerTint(top, flight.sim);
    };
    return { ok: true, above: read(top.up + 6), below: read(Math.max(0.2, top.up - 2)) };
  })()`);
  check(
    'and green from above on a checkpoint you drop through',
    tintUp.ok === true && tintUp.above === 'green' && tintUp.below === 'red',
    tintUp.ok
      ? `above the cube: ${tintUp.above}, inside it: ${tintUp.below}`
      : `skipped — ${tintUp.reason}`,
  );

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

    pick('Race vibes');
    const onRace = { disabled: racePanel.startBtnDisabled, hasCourse: !!scene.track.course };
    racePanel.race.start(0);
    racePanel.race.setDt(0.001);
    racePanel.race.step(-34, 0, 1.5, 0.001);
    scene.setNextCheckpoint(racePanel.race.activeCheckpoint);
    const markerOnRace = race.markerTriangleCount;

    pick('Freestyle');
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
    pick('Race vibes');
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

  // Starting a race does not arm the quad, and a disarmed quad on the ground
  // looks exactly like an armed one nobody is flying — so the clock runs while
  // the sticks do nothing and there is no hint as to why.
  const armWarn = await evaluate(`(async () => {
    const { racePanel, flight, scene, tabs } = globalThis.__fpvsim;
    tabs.show('fly');
    const el = () => document.querySelector('.osd-armwarn');
    const shown = () => {
      const n = el();
      return !!n && n.style.display !== 'none' && (n.textContent || '').length > 0;
    };

    racePanel.race.reset();
    flight.sim.reset(0);
    scene.osd.render(racePanel.race, flight.sim, -1);
    const idle = shown();

    racePanel.race.start(3);
    flight.sim.armed = false;
    scene.osd.render(racePanel.race, flight.sim, -1);
    const disarmedInRace = { shown: shown(), text: el()?.textContent };

    flight.sim.armed = true;
    scene.osd.render(racePanel.race, flight.sim, -1);
    const armedInRace = shown();

    racePanel.race.reset();
    return { idle, disarmedInRace, armedInRace };
  })()`);
  check(
    'starting a race disarmed warns on the video',
    armWarn.disarmedInRace.shown && !armWarn.armedInRace && !armWarn.idle,
    `"${armWarn.disarmedInRace.text}" — shown only while racing and disarmed`,
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

  // Sound. The promise made in Settings is that turning it off is exactly as
  // before, so the checks are as much about what stops as about what plays.
  const soundOn = await evaluate(`(async () => {
    const { audio, flight, scene, poller } = globalThis.__fpvsim;
    audio.setEnabled(true);
    // resume() is asynchronous, and update() is a no-op while the context is
    // still suspended — so measuring straight away reads the oscillators'
    // initial 200 Hz and calls it a failure. Wait for the graph to be running
    // rather than assuming it is.
    for (let i = 0; i < 60 && audio.state !== 'running'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }

    // Spin the motors up properly: an rpm-driven tone is silent on a quad that
    // is not turning, so a check on a disarmed model proves nothing.
    const realPoll = poller.poll.bind(poller);
    poller.poll = (t) => { realPoll(t); poller.connected = true; return true; };
    flight.sim.obstacles = [];
    flight.sim.crashed = false;
    flight.sim.armed = true;
    await new Promise((r) => setTimeout(r, 300));
    // Read the model and the graph in the same breath. The page's own 1 kHz
    // tick keeps stepping underneath, so anything measured across a wait is a
    // race — this asks only whether what is being heard matches what is being
    // flown right now.
    //
    // And sample repeatedly rather than once: every parameter is a smoothed
    // target by design, so a single reading taken while the ramp is still
    // climbing is a measurement of the ramp, not of the mapping. One reading
    // came back at 381 Hz on its way to 1 145.
    let live = audio.debug();
    let rpm = flight.sim.telemetry.motorRpm.slice();
    let bestErr = Infinity;
    for (let i = 0; i < 40; i++) {
      audio.update(flight.sim);
      await new Promise((r) => setTimeout(r, 25));
      const d = audio.debug();
      const r0 = flight.sim.telemetry.motorRpm.slice();
      const want = ((r0[0] ?? 0) / 60) * flight.sim.airframe.prop.blades;
      const err = Math.abs((d.freqs[0] ?? 0) - want);
      if (err < bestErr) {
        bestErr = err;
        live = d;
        rpm = r0;
      }
      if (err < Math.max(25, want * 0.05)) break;
    }

    flight.sim.armed = false;
    poller.poll = realPoll;
    flight.reset();

    // The rpm-to-sound mapping itself, driven from a stand-in rather than from
    // the model, because the live tick will not hold still for a before/after.
    //
    // The wait is a *blocking* one on purpose. Yielding would let the page's own
    // render loop call update() with the real, now-stopped model and pull every
    // target back to silence — which is what the first version of this measured.
    // Blocking the main thread does not stop the audio thread, so the ramp still
    // converges and the reading is of the value actually being heard.
    const at = (r) => {
      audio.update({ telemetry: { motorRpm: [r, r, r, r], speed: 0 } });
      const t0 = performance.now();
      while (performance.now() - t0 < 250) { /* hold the loop out */ }
      return audio.debug();
    };
    const loud = at(24000);
    const quiet = at(3000);

    return {
      state: audio.state,
      active: audio.active,
      live,
      rpm,
      loud,
      quiet,
      blades: flight.sim.airframe.prop.blades,
      map: scene.track.name,
    };
  })()`);
  const expected = ((soundOn.rpm[0] ?? 0) / 60) * soundOn.blades;
  check(
    'sound builds a graph and starts running',
    soundOn.active === true && soundOn.state === 'running' && soundOn.live.freqs.length === 4,
    `${soundOn.live.freqs.length} motor voices, context ${soundOn.state}`,
  );
  check(
    'what is heard is what is flown — blade pass, from the live model',
    (soundOn.rpm[0] ?? 0) > 2000 &&
      Math.abs((soundOn.live.freqs[0] ?? 0) - expected) < Math.max(25, expected * 0.12),
    `${(soundOn.live.freqs[0] ?? 0).toFixed(0)} Hz against ${expected.toFixed(0)} expected from ${(soundOn.rpm[0] ?? 0).toFixed(0)} rpm on ${soundOn.blades} blades`,
  );
  check(
    'and it follows the throttle down',
    (soundOn.quiet.freqs[0] ?? 0) < (soundOn.loud.freqs[0] ?? 0) * 0.4 &&
      (soundOn.quiet.gains[0] ?? 0) < (soundOn.loud.gains[0] ?? 0) * 0.5,
    `24 000 rpm: ${(soundOn.loud.freqs[0] ?? 0).toFixed(0)} Hz at gain ${(soundOn.loud.gains[0] ?? 0).toFixed(3)}; ` +
      `3 000 rpm: ${(soundOn.quiet.freqs[0] ?? 0).toFixed(0)} Hz at gain ${(soundOn.quiet.gains[0] ?? 0).toFixed(3)}`,
  );

  // Crossing a gate has to be audible: in a race the pilot is looking at the
  // next gate, not at the panel, so confirmation that one counted can only
  // arrive in the ear.
  const chime = await evaluate(`(async () => {
    const { audio, racePanel, scene, tabs } = globalThis.__fpvsim;
    audio.setEnabled(true);
    tabs.show('fly');
    const course = racePanel.race.course;
    racePanel.race.laps = 3;
    racePanel.race.start(0);
    const cp = course.checkpoints[0];
    const dt = 0.001;
    // Straight through the first checkpoint, which the page's own tick will
    // notice on its next pass — this is the wiring, not the audio call.
    const at = (f) => {
      racePanel.race.setDt(dt);
      racePanel.race.step(cp.north + cp.dirN * f, cp.east + cp.dirE * f, cp.up, dt);
    };
    at(-4); at(-1); at(1); at(4);
    const crossed = racePanel.race.crossings;
    // Voices decay in about a tenth of a second, so watch rather than sample.
    let peak = 0;
    for (let i = 0; i < 30; i++) {
      peak = Math.max(peak, audio.debug().voices);
      await new Promise((r) => requestAnimationFrame(r));
    }
    racePanel.race.reset();
    return { crossed, peak };
  })()`);
  check(
    'crossing a checkpoint makes a sound',
    chime.crossed > 0 && chime.peak > 0,
    `${chime.crossed} crossing(s) counted in the tick, ${chime.peak} voice(s) heard on the render path`,
  );

  // The gong: hitting scenery sounds, and does so on top of the crash rather
  // than instead of it.
  const gong = await evaluate(`(async () => {
    const { audio } = globalThis.__fpvsim;
    audio.setEnabled(true);
    // Give the sample a moment to fetch and decode; it is loaded lazily, only
    // once a context exists, so a page with sound off never downloads it.
    for (let i = 0; i < 40 && !audio.gongReady; i++) await new Promise((r) => setTimeout(r, 50));
    const before = audio.debug().voices;
    audio.noteStrike(6);
    audio.update({ telemetry: { motorRpm: [0, 0, 0, 0], speed: 0 } });
    let peak = 0;
    for (let i = 0; i < 10; i++) {
      peak = Math.max(peak, audio.debug().voices);
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { ready: audio.gongReady, before, peak };
  })()`);
  check(
    'hitting scenery sounds the gong',
    gong.ready === true && gong.peak > gong.before,
    gong.ready
      ? `sample decoded, ${gong.peak} voice(s) while it rings`
      : 'the gong never decoded',
  );

  const bang = await evaluate(`(async () => {
    const { audio, flight } = globalThis.__fpvsim;
    audio.noteCrash(9);
    audio.update(flight.sim);
    const during = audio.debug().voices;
    return { during };
  })()`);
  check(
    'a crash makes a noise',
    bang.during > 0,
    `${bang.during} impact voice(s), built on the render path rather than in the tick`,
  );

  // The part that has to be true for the promise in Settings to hold.
  const soundOff = await evaluate(`(() => {
    const { audio, flight } = globalThis.__fpvsim;
    audio.setEnabled(false);
    const after = { state: audio.state, active: audio.active };
    // Must be a no-op rather than a throw, since the render loop calls it every
    // frame whether or not anyone is listening.
    let threw = false;
    try { for (let i = 0; i < 100; i++) audio.update(flight.sim); } catch { threw = true; }
    const stored = JSON.parse(localStorage.getItem('fpvsim.audio.v1') || 'null');
    return { ...after, threw, stored, debug: audio.debug() };
  })()`);
  check(
    'turning it off closes the graph rather than muting it',
    soundOff.active === false && soundOff.state === 'closed' && soundOff.debug.freqs.length === 0,
    'context closed, no oscillators left — nothing on the audio thread',
  );
  check(
    'and updating it afterwards costs a property check',
    soundOff.threw === false,
    '100 update() calls with sound off, no graph touched and nothing thrown',
  );
  check(
    'the choice is stored',
    soundOff.stored && soundOff.stored.enabled === false,
    JSON.stringify(soundOff.stored),
  );

  const soundUi = await evaluate(`(() => {
    const { audio, tabs } = globalThis.__fpvsim;
    tabs.show('fly');
    const btn = document.querySelector('#audio-toggle');
    const box = document.querySelector('#sound-enabled');
    btn.click();                       // back on, from the flying tab
    const afterBtn = { on: audio.enabled, box: box.checked, label: btn.textContent };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    const afterKey = { on: audio.enabled, box: box.checked, label: btn.textContent };
    audio.setEnabled(true);
    return { afterBtn, afterKey };
  })()`);
  check(
    'the button on the flying tab and the checkbox in Settings stay in step',
    soundUi.afterBtn.on === true && soundUi.afterBtn.box === true &&
      soundUi.afterKey.on === false && soundUi.afterKey.box === false,
    `button -> ${soundUi.afterBtn.label}, then M -> ${soundUi.afterKey.label}; one owner, two views`,
  );

  // Usage reporting. It is the first thing here that leaves the browser, so
  // what is checked is mostly what it refuses to do: nothing from a dev build,
  // nothing once the pilot opts out, and nothing counted while disarmed.
  const teleId = await evaluate(`(() => {
    const { telemetry } = globalThis.__fpvsim;
    const stored = JSON.parse(localStorage.getItem('fpvsim.pilot.v1') || 'null');
    return {
      id: telemetry.pilotId,
      storedId: stored && stored.id,
      enabled: telemetry.enabled,
      transmits: telemetry.transmits,
      boxChecked: document.querySelector('#telemetry-enabled').checked,
      optKey: localStorage.getItem('fpvsim.telemetry.v1'),
    };
  })()`);
  check(
    'a pilot id is minted and persisted',
    typeof teleId.id === 'string' && teleId.id.length > 8 && teleId.storedId === teleId.id,
    `${teleId.id.slice(0, 8)}… under fpvsim.pilot.v1`,
  );
  check(
    'sharing defaults on, with no stored key needed to say so',
    teleId.enabled === true && teleId.boxChecked === true && teleId.optKey === null,
    'checkbox reflects the default rather than a written value',
  );
  check(
    'and a dev build transmits nothing',
    teleId.transmits === false,
    'import.meta.env.DEV, so the endpoint is never called from here',
  );

  // Armed seconds are the number the whole thing exists to produce, so they are
  // checked against the clock and against the map actually loaded — a counter
  // that runs while the quad sits disarmed on the ground would report a pilot
  // who left the tab open as the most dedicated one there is.
  const armedCount = await evaluate(`(async () => {
    const { telemetry, flight, scene, poller } = globalThis.__fpvsim;
    const map = scene.track.name;
    const of = () => (telemetry.report().maps.find((m) => m.name === map) || { armedS: 0 }).armedS;

    // Hold the link up for the measurement. Headless usually has no radio, and
    // the failsafe correctly disarms the model on the very next tick — which
    // would make this check measure the failsafe rather than the counter.
    const realPoll = poller.poll.bind(poller);
    poller.poll = (t) => { realPoll(t); poller.connected = true; return true; };

    flight.sim.crashed = false;
    flight.sim.armed = false;
    const idle0 = of();
    await new Promise((r) => setTimeout(r, 400));
    const idle1 = of();

    flight.sim.armed = true;
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 600));
    const wall = (performance.now() - t0) / 1000;
    flight.sim.armed = false;
    const flown = of() - idle1;

    await new Promise((r) => setTimeout(r, 300));
    const after = of();

    poller.poll = realPoll;
    flight.sim.crashed = false;
    flight.reset();
    return { idleDrift: idle1 - idle0, flown, wall, stopped: after - idle1 - flown, map };
  })()`);
  check(
    'armed seconds track the clock on the loaded map',
    Math.abs(armedCount.flown - armedCount.wall) < 0.15 && armedCount.flown > 0.3,
    `${armedCount.flown.toFixed(2)} s counted over ${armedCount.wall.toFixed(2)} s of wall clock on "${armedCount.map}"`,
  );
  check(
    'and nothing accrues while disarmed',
    armedCount.idleDrift === 0 && Math.abs(armedCount.stopped) < 0.05,
    `${armedCount.idleDrift.toFixed(3)} s before arming, ${armedCount.stopped.toFixed(3)} s after disarming`,
  );

  // The beacon itself, with transmission forced on: what a production build
  // would send, and what the opt-out has to stop.
  const beacon = await evaluate(`(async () => {
    const { telemetry, scene } = globalThis.__fpvsim;
    const sent = [];
    const real = navigator.sendBeacon;
    navigator.sendBeacon = (url, body) => { sent.push({ url, body }); return true; };
    const wasEnabled = telemetry.enabled;

    telemetry.transmits = true;
    telemetry.setName('  <script>alert(1)</script>  ');
    telemetry.enabled = true;
    const okSend = telemetry.send();
    const unchanged = telemetry.send();  // nothing new to say

    telemetry.noteCrash(scene.track.name);
    telemetry.setEnabled(false);         // sends a final summary, then goes quiet
    const afterOptOut = telemetry.send();

    telemetry.transmits = false;
    telemetry.enabled = wasEnabled;
    localStorage.removeItem('fpvsim.telemetry.v1');
    navigator.sendBeacon = real;

    const texts = [];
    for (const s of sent) texts.push(JSON.parse(await s.body.text()));
    return {
      okSend,
      unchanged,
      afterOptOut,
      urls: sent.map((s) => s.url),
      count: sent.length,
      first: texts[0],
      map: scene.track.name,
      storedName: JSON.parse(localStorage.getItem('fpvsim.pilot.v1') || '{}').name,
    };
  })()`);
  check(
    'the beacon goes to this page\'s own host and nowhere else',
    beacon.okSend === true && beacon.urls.every((u) => u === '/api/session'),
    `${beacon.count} POST(s) to ${[...new Set(beacon.urls)].join(', ')} — relative, so no third party`,
  );
  check(
    'the summary carries the pilot, the tune and the maps',
    beacon.first &&
      beacon.first.pilotId === teleId.id &&
      beacon.first.name === '<script>alert(1)</script>' &&
      !!beacon.first.tune?.rates &&
      !!beacon.first.tune?.pids &&
      beacon.first.maps.some((m) => m.name === beacon.map && m.armedS > 0),
    `name, rates, pids and ${beacon.first?.maps?.length ?? 0} map(s) including "${beacon.map}"`,
  );
  check(
    'a name is trimmed and stored, and left un-sanitised for the reader to escape',
    beacon.storedName === '<script>alert(1)</script>',
    'the admin page is where a name is escaped — mangling it here would hide that it must be',
  );
  check(
    'an unchanged summary is not resent',
    beacon.unchanged === false,
    'an idle tab posts once, and pagehide plus visibilitychange do not each leave a copy',
  );
  check(
    'opting out stops it, after one last summary',
    beacon.afterOptOut === false && beacon.count === 2,
    'the flying already done is reported rather than discarded, then nothing further',
  );
  check(
    'and the summary is free of anything that identifies a machine',
    beacon.first && !('ua' in beacon.first) && !('userAgent' in beacon.first) && !('ip' in beacon.first),
    Object.keys(beacon.first ?? {}).join(', '),
  );

  // Destructive, so it runs last: it wipes stored settings and switches tab,
  // and an earlier version of it sitting mid-suite broke two later checks.
  // Reset everything. Two presses, and it must clear every key the app owns —
  // the reason it discovers them by prefix rather than from a list.
  const resetAll = await evaluate(`(() => {
    const { tabs } = globalThis.__fpvsim;
    tabs.show('settings');
    // Seed one of each, including a key added after this button was written —
    // a hard-coded list would miss that one, which is the failure being
    // guarded against.
    localStorage.setItem('fpvsim.mappings.v1', '{}');
    localStorage.setItem('fpvsim.tune.v1', '{}');
    localStorage.setItem('fpvsim.scene.v1', '{}');
    localStorage.setItem('fpvsim.tab.v1', 'settings');
    localStorage.setItem('fpvsim.audio.v1', '{}');
    localStorage.setItem('fpvsim.pilot.v1', '{}');
    localStorage.setItem('fpvsim.telemetry.v1', '{}');
    localStorage.setItem('fpvsim.something.new.v1', '{}');
    localStorage.setItem('somebody-elses-key', 'keep me');

    const btn = document.querySelector('#reset-all-btn');
    btn.click();
    const armed = btn.textContent;
    const listed = document.querySelector('#reset-all-state').textContent;

    // Second press erases. Stop the reload from taking the page away.
    const realReload = globalThis.location.reload;
    let reloaded = false;
    try {
      Object.defineProperty(globalThis.location, 'reload', {
        configurable: true,
        value: () => { reloaded = true; },
      });
    } catch { /* some browsers refuse; the key check below still stands */ }
    btn.click();

    const left = Object.keys(localStorage).filter((k) => k.startsWith('fpvsim.'));
    const foreign = localStorage.getItem('somebody-elses-key');
    localStorage.removeItem('somebody-elses-key');
    return { armed, listed, left, foreign, label: btn.textContent };
  })()`);
  check(
    'reset all asks twice before erasing',
    /again/i.test(resetAll.armed) && resetAll.listed.length > 0,
    `first press: "${resetAll.armed}", and it lists what will go`,
  );
  check(
    'and clears every key the app owns, including ones added later',
    resetAll.left.length === 0,
    resetAll.left.length === 0
      ? 'discovered by prefix, so a new key needs no code change here'
      : `left behind: ${resetAll.left.join(', ')}`,
  );
  check(
    'while leaving keys it does not own alone',
    resetAll.foreign === 'keep me',
    'only the fpvsim. prefix is cleared',
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
    if (process.env.SHOT_ARMWARN) {
      await evaluate(`(() => {
        const { racePanel, flight, scene } = globalThis.__fpvsim;
        racePanel.race.reset();
        racePanel.race.start(3);
        flight.sim.armed = false;
        scene.osd.render(racePanel.race, flight.sim, -1);
      })()`);
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
