import './style.css';
import {
  auxActive,
  AUX_ACTIONS,
  AUX_INFO,
  type AuxAction,
  type AuxBinding,
  CHANNELS,
  CHANNEL_INFO,
  applyModePreset,
  clearMapping,
  computeCommands,
  loadMapping,
  newMapping,
  saveMapping,
  type Channel,
  type Commands,
  type Mapping,
  type StickMode,
} from './mapping.ts';
import {
  AxisDetector,
  EndpointCalibrator,
  GamepadPoller,
  MAX_BUTTONS,
  SwitchDetector,
} from './gamepad.ts';
import { JitterRun, type RunResult, type Stats } from './jitter.ts';
import { FlightPanel } from './flight-panel.ts';
import { AuxControl } from './aux-control.ts';
import { Tabs } from './tabs.ts';
import { clearStored, describeStored } from './reset-all.ts';
import { RacePanel } from './race-panel.ts';
import { applyRates, AXIS_ROLL, AXIS_PITCH, AXIS_YAW } from './flight/rates.ts';
import { SceneView } from './scene-view.ts';
import { TunePanel } from './tune-panel.ts';
import TickerWorker from './ticker.worker.ts?worker';
import {
  CTRL_FUTEX,
  CTRL_PERIOD_US,
  CTRL_RUNNING,
  type ReadyMsg,
  type TickMsg,
  type TickerBackend,
} from './ticker-protocol.ts';

// ---------------------------------------------------------------- state

const poller = new GamepadPoller();
const detector = new AxisDetector(poller);
const calibrator = new EndpointCalibrator(poller);

let mapping: Mapping = newMapping('(none)');
let commands: Commands = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
let detectingChannel: Channel | null = null;
let detectMessage = '';
let run: JitterRun | null = null;
let lastResult: RunResult | null = null;
let tickerBackend: TickerBackend | 'starting' = 'starting';
let tickerCtrl: Int32Array | null = null;
let pollHz = 1000;
let saveNote = '';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

// ---------------------------------------------------------------- hot path

const worker = new TickerWorker();

worker.onmessage = (e: MessageEvent<TickMsg | ReadyMsg>) => {
  const msg = e.data;
  if (msg.type === 'ready') {
    tickerBackend = msg.backend;
    tickerCtrl = msg.ctrl ? new Int32Array(msg.ctrl) : null;
    setTickRate(pollHz);
    setTicking(true);
    return;
  }
  onTick(msg.fired, msg.scheduled);
};

/**
 * The atomics-backed worker blocks in Atomics.wait and never reaches its event
 * loop, so control goes through shared memory. The timeout fallback still
 * listens for messages.
 */
function setTickRate(hz: number): void {
  if (tickerCtrl) Atomics.store(tickerCtrl, CTRL_PERIOD_US, Math.round(1_000_000 / hz));
  else worker.postMessage({ type: 'setHz', hz });
}

function setTicking(on: boolean): void {
  if (tickerCtrl) {
    Atomics.store(tickerCtrl, CTRL_RUNNING, on ? 1 : 0);
    Atomics.notify(tickerCtrl, CTRL_FUTEX);
  } else {
    worker.postMessage(on ? { type: 'start', hz: pollHz } : { type: 'stop' });
  }
}

// Declared above onTick rather than with the rest of the wiring at the bottom:
// ticks only arrive via a message event, so module evaluation has always
// finished by then, but relying on that would make the ordering a trap for
// whoever moves this next.
const flight = new FlightPanel(
  $('flight-live'),
  $('flight-panel'),
  $('quad-check'),
  $('recorder-panel'),
);
const auxControl = new AuxControl();
const switchDetector = new SwitchDetector(poller);
const scene = new SceneView($('scene-view'), flight.sim);
const tune = new TunePanel($('tune-panel'), flight.sim, $('pid-panel'));
const racePanel = new RacePanel($('race-panel'), flight.sim);
racePanel.onArmAtStart = () => {
  scene.placeAtStart();
  flight.reset();
};
// A race belongs to the map whose gates are actually standing there. Without
// this the timer ran its own course whatever was loaded, and the checkpoint
// markers hung in mid-air over ground with no gates on it.
scene.onTrackChange = (track) => racePanel.setCourse(track.course ?? null);
racePanel.setCourse(scene.track.course ?? null);
// The scene owns where the quad belongs once a track is loaded, and which of
// the reset modes is in force.
flight.onReset = () => {
  scene.reset();
  racePanel.race.invalidateLap();
};
flight.onArmed = () => {
  hasArmed = true;
};

/** Seconds left before a mid-race crash respawns itself; <0 when idle. */
let crashRecover = -1;
const CRASH_PAUSE = 1.2;

const tabs = new Tabs();

/**
 * The whole input path, in one place, with nothing awaited. The physics step
 * is here, immediately after the poll.
 */
function onTick(fired: number, scheduled: number): void {
  poller.poll(fired);
  calibrator.update();

  const detected = detector.update(fired);
  if (detected && detectingChannel) {
    const ch = detectingChannel;
    const m = mapping.channels[ch];
    m.axis = detected.axis;
    // "Positive" is whatever direction the pilot just moved.
    m.invert = detected.direction < 0;
    detectMessage = `${CHANNEL_INFO[ch].label} → axis ${detected.axis}${m.invert ? ' (inverted)' : ''}`;
    detectingChannel = null;
    persist();
  } else if (detector.active === false && detectingChannel && !detected) {
    detectMessage = `No clear movement on ${CHANNEL_INFO[detectingChannel].label} — try again and move the stick to its stop.`;
    detectingChannel = null;
  }

  // Binding a switch. Threshold sits between the two positions rather than at
  // zero: a three-position switch reads -1/0/+1, and a threshold of 0 would
  // make the middle position ambiguous.
  const bound = switchDetector.update(fired);
  if (bindingAux && bound) {
    const b = mapping.aux[bindingAux];
    b.source = bound.source;
    b.index = bound.index;
    b.invert = bound.invert;
    b.threshold = bound.source === 'button' ? 0.5 : Math.abs(bound.onValue) / 2;
    bindMessage = `${AUX_INFO[bindingAux].label} → ${bound.source} ${bound.index}${bound.invert ? ' (inverted)' : ''}`;
    bindingAux = null;
    auxControl.reset();
    persist();
    queueMicrotask(buildAuxRows);
  } else if (bindingAux && !switchDetector.active) {
    bindMessage = `Nothing moved far enough — flick the switch fully and try again.`;
    bindingAux = null;
  }

  const aux = auxControl.update(
    mapping,
    poller.axes as unknown as number[],
    poller.buttons as unknown as number[],
    poller.connected,
  );
  if (mapping.aux.reset.source !== 'none' && aux.resetEdge) flight.reset();

  commands = computeCommands(mapping, poller.axes as unknown as number[]);

  // No link means no input, and that has to be said explicitly. With no device
  // the poller returns early and leaves its axis array at zero, and a raw zero
  // on a *unipolar* channel is mid-travel, not the bottom — so an unmapped,
  // unplugged radio was reading as 55% throttle. The failsafe disarms, so
  // nothing ever flew away on it, but every consumer downstream was being told
  // the pilot was holding half throttle.
  if (!poller.connected) {
    commands.throttle = 0;
    commands.roll = 0;
    commands.pitch = 0;
    commands.yaw = 0;
  }

  // The arm switch is followed after the commands are computed, so the throttle
  // it is checked against is this tick's rather than the last one's.
  if (mapping.aux.arm.source !== 'none') flight.setArmLevel(aux.armOn, commands);

  // The physics step, in the tick and immediately after the poll — the position
  // M0 existed to make safe. It costs a few microseconds of a 1000 us budget.
  flight.step(commands, poller.connected);

  // Automatic crash recovery, while a race is on.
  //
  // Without it a crash ends the race in practice: the quad lies there with the
  // clock running while the pilot reaches for a key. Racing means carrying on,
  // so the quad picks itself up where it went in. The lap is void either way —
  // this makes the race finishable, not cheaper.
  //
  // The pause is so the crash registers as one. Respawning instantly reads as
  // a glitch rather than as having hit something.
  const racing = racePanel.race.state === 'running';
  if (racing && flight.sim.crashed) {
    if (crashRecover < 0) crashRecover = CRASH_PAUSE;
    else {
      crashRecover -= flight.sim.dt;
      if (crashRecover <= 0) {
        crashRecover = -1;
        flight.reset(true);
      }
    }
  } else if (!flight.sim.crashed) {
    crashRecover = -1;
  }

  // Race timing runs in the tick too. Read off the 30 Hz render loop instead
  // and every split would be quantised to 33 ms, which is most of the gap
  // between a good lap and a bad one.
  racePanel.step(flight.sim.dt);

  if (run?.running) {
    run.recordTick(fired, scheduled);
    if (run.elapsedS(fired) >= run.durationS) finishRun();
  }
}

poller.onFresh = (tNow) => {
  run?.recordFresh(tNow);
};

// ---------------------------------------------------------------- devices

function refreshDevices(): void {
  const sel = $<HTMLSelectElement>('device-select');
  const devices = GamepadPoller.list();
  const previous = poller.index;

  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = '-1';
  none.textContent = devices.length ? '— select a device —' : '— no device detected —';
  sel.append(none);

  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = String(d.index);
    opt.textContent = `${d.index}: ${d.id} — ${d.axisCount} axes, ${d.buttonCount} buttons`;
    sel.append(opt);
  }

  // Auto-select when there is exactly one and nothing chosen yet.
  const keep = devices.find((d) => d.index === previous);
  const target = keep ?? (devices.length === 1 ? devices[0] : undefined);
  if (target) {
    sel.value = String(target.index);
    if (previous !== target.index) selectDevice(target.index, target.id);
  } else {
    sel.value = '-1';
  }
  buildRawRows(devices.find((d) => d.index === poller.index)?.axisCount ?? 0);
}

function selectDevice(index: number, id: string): void {
  poller.select(index);
  // A binding on the old radio says nothing about the new one, and the arm
  // guard in particular has to be re-earned on the new device.
  auxControl.reset();
  poller.id = id;
  mapping = loadMapping(id) ?? newMapping(id);
  saveNote = loadMapping(id) ? 'loaded saved mapping' : 'new mapping (mode 2 preset)';
  $<HTMLSelectElement>('mode-select').value = String(mapping.mode);
  buildChannelRows();
}

function persist(): void {
  saveMapping(mapping);
  saveNote = `saved ${new Date().toLocaleTimeString()}`;
}

// ---------------------------------------------------------------- raw UI

interface AxisRow { root: HTMLElement; fill: HTMLElement; val: HTMLElement; idx: HTMLElement; }
let axisRows: AxisRow[] = [];
let buttonCells: HTMLElement[] = [];

function buildRawRows(axisCount: number): void {
  const list = $('axes-list');
  if (axisRows.length !== axisCount) {
    list.innerHTML = '';
    axisRows = [];
    for (let i = 0; i < axisCount; i++) {
      const root = document.createElement('div');
      root.className = 'axis-row';
      root.innerHTML =
        `<span class="idx">ax${i}</span>` +
        `<span class="bar"><span class="center"></span><span class="fill"></span></span>` +
        `<span class="val">0.0000</span>`;
      list.append(root);
      axisRows.push({
        root,
        fill: root.querySelector('.fill') as HTMLElement,
        val: root.querySelector('.val') as HTMLElement,
        idx: root.querySelector('.idx') as HTMLElement,
      });
    }
  }

  const btns = $('buttons-list');
  if (buttonCells.length === 0) {
    for (let i = 0; i < MAX_BUTTONS; i++) {
      const cell = document.createElement('div');
      cell.className = 'btn-cell';
      cell.textContent = `b${i}`;
      btns.append(cell);
      buttonCells.push(cell);
    }
  }
}

// ---------------------------------------------------------------- mapping UI

interface ChannelRow { root: HTMLElement; select: HTMLSelectElement; out: HTMLElement; fill: HTMLElement; detect: HTMLButtonElement; }
const channelRows = new Map<Channel, ChannelRow>();

// ---------------------------------------------------------------- aux rows

interface AuxRow {
  root: HTMLElement;
  sourceSel: HTMLSelectElement;
  indexSel: HTMLSelectElement;
  invert: HTMLInputElement;
  state: HTMLElement;
  detect: HTMLButtonElement;
}

const auxRows = new Map<AuxAction, AuxRow>();
let bindingAux: AuxAction | null = null;
let bindMessage = '';

function startBind(action: AuxAction): void {
  bindingAux = action;
  bindMessage = `Flick the ${AUX_INFO[action].label.toLowerCase()} switch now…`;
  switchDetector.start(performance.now());
}

function buildAuxRows(): void {
  const host = $('aux-rows');
  host.innerHTML = '';
  auxRows.clear();

  for (const action of AUX_ACTIONS) {
    const b = mapping.aux[action];
    const root = document.createElement('div');
    root.className = 'channel';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = AUX_INFO[action].label;

    const detect = document.createElement('button');
    detect.type = 'button';
    detect.textContent = 'Bind';
    detect.onclick = () => startBind(action);

    const sourceSel = document.createElement('select');
    for (const [v, label] of [
      ['none', 'unbound'],
      ['axis', 'axis'],
      ['button', 'button'],
    ] as const) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      sourceSel.append(o);
    }
    sourceSel.value = b.source;
    sourceSel.onchange = () => {
      b.source = sourceSel.value as AuxBinding['source'];
      if (b.source !== 'none' && b.index < 0) b.index = 0;
      auxControl.reset();
      persist();
      buildAuxRows();
    };

    const indexSel = document.createElement('select');
    const rebuildIndexes = (): void => {
      indexSel.innerHTML = '';
      const n = b.source === 'button' ? Math.max(poller.buttonCount, 8) : Math.max(poller.axisCount, 8);
      for (let i = 0; i < n; i++) {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = `${b.source === 'button' ? 'button' : 'axis'} ${i}`;
        indexSel.append(o);
      }
      indexSel.value = String(Math.max(0, b.index));
      indexSel.disabled = b.source === 'none';
    };
    rebuildIndexes();
    indexSel.onchange = () => {
      b.index = Number(indexSel.value);
      auxControl.reset();
      persist();
    };

    const invLabel = document.createElement('label');
    const invert = document.createElement('input');
    invert.type = 'checkbox';
    invert.checked = b.invert;
    invert.disabled = b.source === 'none';
    invert.onchange = () => {
      b.invert = invert.checked;
      auxControl.reset();
      persist();
    };
    invLabel.append(invert, document.createTextNode(' invert'));

    const state = document.createElement('span');
    state.className = 'aux-state';

    root.append(name, detect, sourceSel, indexSel, invLabel, state);
    host.append(root);
    auxRows.set(action, { root, sourceSel, indexSel, invert, state, detect });
  }
}

function buildChannelRows(): void {
  const host = $('channel-rows');
  host.innerHTML = '';
  channelRows.clear();

  for (const ch of CHANNELS) {
    const m = mapping.channels[ch];
    const root = document.createElement('div');
    root.className = 'channel';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = CHANNEL_INFO[ch].label;

    const detect = document.createElement('button');
    detect.type = 'button';
    detect.textContent = 'Detect';
    detect.onclick = () => startDetect(ch);

    const select = document.createElement('select');
    const unassigned = document.createElement('option');
    unassigned.value = '-1';
    unassigned.textContent = 'unassigned';
    select.append(unassigned);
    for (let i = 0; i < Math.max(poller.axisCount, 8); i++) {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = `axis ${i}`;
      select.append(o);
    }
    select.value = String(m.axis);
    select.onchange = () => {
      m.axis = Number(select.value);
      persist();
    };

    const invertLabel = document.createElement('label');
    const invert = document.createElement('input');
    invert.type = 'checkbox';
    invert.checked = m.invert;
    invert.onchange = () => {
      m.invert = invert.checked;
      persist();
    };
    invertLabel.append(invert, document.createTextNode('invert'));

    const dbLabel = document.createElement('label');
    const db = document.createElement('input');
    db.type = 'number';
    db.min = '0';
    db.max = '0.5';
    db.step = '0.01';
    db.value = String(m.deadband);
    db.onchange = () => {
      m.deadband = Math.min(0.5, Math.max(0, Number(db.value) || 0));
      db.value = String(m.deadband);
      persist();
    };
    dbLabel.append(document.createTextNode('dead'), db);

    const bar = document.createElement('span');
    bar.className = 'bar';
    bar.innerHTML = '<span class="center"></span><span class="fill"></span>';

    const out = document.createElement('span');
    out.className = 'out';
    out.textContent = '0.000';

    root.append(name, detect, select, invertLabel, dbLabel, bar, out);
    host.append(root);
    channelRows.set(ch, { root, select, out, fill: bar.querySelector('.fill') as HTMLElement, detect });
  }
}

function startDetect(ch: Channel): void {
  if (!poller.connected) {
    detectMessage = 'No device selected.';
    return;
  }
  detectingChannel = ch;
  detectMessage = `Move ${CHANNEL_INFO[ch].positive}…`;
  detector.start(performance.now());
}

// ---------------------------------------------------------------- render

let lastRender = 0;

/** Set once the pilot has armed successfully, so first-run advice can retire. */
let hasArmed = false;

/**
 * One line, in words, when something about the environment will confuse a
 * visiting pilot. The status pills report `isolated: no` and `ticker: timeout`
 * accurately and mean nothing to someone who has just been sent a link.
 *
 * Ordered by how badly it blocks them: no radio support at all, then degraded
 * timing, then the first-run dead end where an uncalibrated throttle reads
 * mid-travel and arming is refused for a reason that sounds like the pilot's
 * fault.
 */
function renderNotice(isolated: boolean): void {
  const box = $('notice');
  let cls = 'notice bad';
  let html = '';

  if (!GamepadPoller.apiAvailable) {
    html =
      '<strong>This page cannot see your radio.</strong> Browsers only expose ' +
      'gamepads over HTTPS, and this page was served over plain http. Ask ' +
      'whoever sent you the link for an https:// one — everything else works, ' +
      'but nothing can be flown without it.';
  } else if (!globalThis.isSecureContext) {
    // Distinct from the case below, and the distinction matters: over an
    // untrustworthy origin the browser *ignores* COOP/COEP rather than the host
    // failing to send them, so "your host is misconfigured" would send someone
    // to fix the wrong thing. Chrome says as much in the console.
    html =
      '<strong>This page was served over plain http, so a lot of it is ' +
      'switched off.</strong> Browsers only expose gamepads, and only honour ' +
      'the isolation headers, on a trustworthy origin. Over http to an IP ' +
      'address you can look around but not fly. Ask for an https:// link, or ' +
      'open it on the machine hosting it as http://localhost — localhost counts ' +
      'as trustworthy and everything works there.';
  } else if (!isolated) {
    cls = 'notice warn';
    html =
      '<strong>Timing is running in fallback mode.</strong> The host is not ' +
      'sending the COOP/COEP headers, so the 1 kHz loop is paced by a timer ' +
      'rather than by shared memory. It still flies and the flight model is ' +
      'unaffected — this is loop precision only, and worth mentioning if ' +
      'something feels stuttery.';
  } else if (poller.connected && !hasArmed && commands.throttle > 0.05) {
    cls = 'notice warn';
    html =
      `<strong>Throttle is reading ${(commands.throttle * 100).toFixed(0)}%.</strong> ` +
      'If your sticks are at rest, that channel is not calibrated yet, and ' +
      'arming will be refused until it reads zero. Go to <em>2 · Channel ' +
      'mapping</em>, use <em>Detect</em> on throttle, then <em>Calibrate ' +
      'endpoints</em> and sweep every stick to its stops.';
  }

  box.className = cls;
  box.innerHTML = html;
  box.hidden = html.length === 0;
}

function render(tNow: number): void {
  requestAnimationFrame(render);
  run?.recordFrame(tNow);

  // The 3D view draws every frame; the text panels do not need to, and
  // rebuilding their DOM at display rate would cost more than the scene does.
  // Only the visible tab draws. The physics is unaffected either way — it runs
  // on the worker ticker, so the quad keeps flying while you are in Settings.
  if (tabs.visible('fly')) scene.render();
  // The quad model draws every frame too: a prop stepped at 30 Hz strobes.
  if (tabs.visible('instruments')) {
    // The pilot's own rate curve drives the model, so the stick check verifies
    // the rates as well as the channel directions.
    flight.renderQuad(
      commands,
      [
        applyRates(flight.sim.rates, AXIS_ROLL, commands.roll),
        applyRates(flight.sim.rates, AXIS_PITCH, commands.pitch),
        applyRates(flight.sim.rates, AXIS_YAW, commands.yaw),
      ],
      tNow,
    );
  }

  if (tNow - lastRender < 33) return; // 30 Hz is plenty for text
  lastRender = tNow;

  flight.render();
  racePanel.render();

  // Point the pilot at the next checkpoint while a race is on.
  // A crash mid-race respawns where it happened, so the pilot can carry on to
  // the finish; the lap is voided either way.
  const raceOn = racePanel.race.state === 'running' || racePanel.race.state === 'countdown';
  scene.forceInPlace = raceOn;
  scene.setRacing(raceOn);

  const active = racePanel.race.state === 'running' ? racePanel.race.activeCheckpoint : null;
  scene.setNextCheckpoint(active);
  scene.osd.render(racePanel.race, flight.sim, crashRecover);
  if (tabs.visible('fly')) scene.updateSticks(commands, mapping.mode);

  // pills
  const pills = $('status-pills');
  const coi = globalThis.crossOriginIsolated === true;
  const items: { text: string; cls: string }[] = [
    { text: poller.connected ? `● ${poller.id.slice(0, 42)}` : '○ no device', cls: poller.connected ? 'good' : 'bad' },
    { text: `ticker: ${tickerBackend}`, cls: tickerBackend === 'atomics' ? 'good' : tickerBackend === 'timeout' ? 'warn' : '' },
    { text: `isolated: ${coi ? 'yes' : 'no'}`, cls: coi ? 'good' : 'warn' },
    { text: `polls: ${poller.polls.toLocaleString()}`, cls: '' },
  ];
  pills.innerHTML = items.map((i) => `<span class="pill ${i.cls}">${i.text}</span>`).join('');

  renderNotice(coi);

  // Aux switch state, live, so a pilot can see the binding working before they
  // trust it in the air.
  for (const action of AUX_ACTIONS) {
    const row = auxRows.get(action);
    if (!row) continue;
    const b = mapping.aux[action];
    row.detect.textContent = bindingAux === action ? 'flick it…' : 'Bind';
    if (b.source === 'none') {
      row.state.textContent = 'unbound';
      row.state.className = 'aux-state';
      continue;
    }
    const on = auxActive(b, poller.axes as unknown as number[], poller.buttons as unknown as number[]);
    if (action === 'arm' && on && !auxControl.state.armReady) {
      row.state.textContent = 'ON — flick off to enable';
      row.state.className = 'aux-state warn';
    } else {
      row.state.textContent = on ? 'ON' : 'off';
      row.state.className = on ? 'aux-state on' : 'aux-state';
    }
  }
  $('bind-message').textContent = bindMessage;

  // raw axes
  if (axisRows.length !== poller.axisCount) buildRawRows(poller.axisCount);
  const assigned = new Set(CHANNELS.map((c) => mapping.channels[c].axis));
  for (let i = 0; i < axisRows.length; i++) {
    const row = axisRows[i];
    if (!row) continue;
    const v = poller.axes[i] ?? 0;
    row.val.textContent = v.toFixed(4);
    const pct = ((v + 1) / 2) * 100;
    row.fill.style.left = `${Math.min(50, pct)}%`;
    row.fill.style.width = `${Math.abs(pct - 50)}%`;
    row.root.classList.toggle('assigned', assigned.has(i));
    if (calibrator.active) {
      const lo = calibrator.min[i];
      const hi = calibrator.max[i];
      if (lo !== undefined && hi !== undefined && Number.isFinite(lo)) {
        row.idx.textContent = `ax${i}`;
        row.val.textContent = `${v.toFixed(3)} [${lo.toFixed(2)}…${hi.toFixed(2)}]`;
      }
    } else {
      row.idx.textContent = `ax${i}`;
    }
  }

  for (let i = 0; i < buttonCells.length; i++) {
    const cell = buttonCells[i];
    if (!cell) continue;
    const on = i < poller.buttonCount && (poller.buttons[i] ?? 0) > 0.5;
    cell.classList.toggle('on', on);
    cell.style.display = i < poller.buttonCount ? '' : 'none';
  }

  // channels
  for (const ch of CHANNELS) {
    const row = channelRows.get(ch);
    if (!row) continue;
    const m = mapping.channels[ch];
    const v = commands[ch];
    row.out.textContent = v.toFixed(3);
    row.select.value = String(m.axis);
    row.root.classList.toggle('unassigned', m.axis < 0);
    row.root.classList.toggle('detecting', detectingChannel === ch);
    row.detect.classList.toggle('active', detectingChannel === ch);
    if (CHANNEL_INFO[ch].unipolar) {
      row.fill.style.left = '0%';
      row.fill.style.width = `${v * 100}%`;
    } else {
      const pct = ((v + 1) / 2) * 100;
      row.fill.style.left = `${Math.min(50, pct)}%`;
      row.fill.style.width = `${Math.abs(pct - 50)}%`;
    }
  }

  $('mapping-hint').dataset['msg'] = '';
  $<HTMLElement>('save-state').textContent = [detectMessage, saveNote].filter(Boolean).join(' · ');

  // jitter progress. The run normally ends on a tick; ending it here as well
  // means a stalled ticker shows up as a bad result instead of hanging forever.
  if (run?.running) {
    const el = run.elapsedS(tNow);
    $('jitter-progress').textContent = `${el.toFixed(1)} / ${run.durationS} s · ${run.tickInterval.length.toLocaleString()} ticks`;
    if (el >= run.durationS + 0.25) finishRun();
  }
}

// ---------------------------------------------------------------- jitter run

function startRun(): void {
  const durationS = Number($<HTMLInputElement>('jitter-duration').value) || 60;
  const hz = Number($<HTMLInputElement>('jitter-hz').value) || 1000;
  if (hz !== pollHz) {
    pollHz = hz;
    setTickRate(hz);
  }
  poller.resetCounters();
  run = new JitterRun(durationS, hz);
  run.start(performance.now());
  $<HTMLButtonElement>('jitter-start').disabled = true;
  $('jitter-results').innerHTML = '';
}

function finishRun(): void {
  if (!run) return;
  run.stop();
  lastResult = run.result({
    backend: tickerBackend,
    device: poller.id || '(none)',
    deviceAxes: poller.axisCount,
    polls: poller.polls,
    freshSamples: poller.freshSamples,
    missedPolls: poller.missedPolls,
  });
  run = null;
  $<HTMLButtonElement>('jitter-start').disabled = false;
  $('jitter-progress').textContent = 'done';
  renderResults(lastResult);
}

function statRow(name: string, s: Stats): string {
  const f = (v: number) => (v === 0 && s.count === 0 ? '—' : v.toFixed(3));
  return `<tr><td>${name}</td><td>${s.count.toLocaleString()}</td><td>${f(s.meanMs)}</td><td>${f(s.sdMs)}</td><td>${f(s.minMs)}</td><td>${f(s.p50)}</td><td>${f(s.p90)}</td><td>${f(s.p99)}</td><td>${f(s.p999)}</td><td>${f(s.maxMs)}</td></tr>`;
}

function renderResults(r: RunResult): void {
  const host = $('jitter-results');
  const jitterSd = r.tickInterval.sdMs;
  const cls = jitterSd < 0.5 && r.stalls.over8ms === 0 ? 'good' : jitterSd < 2 ? 'warn' : 'bad';
  const verdict =
    cls === 'good'
      ? 'Tick pacing is solid enough for a 1 kHz physics loop.'
      : cls === 'warn'
        ? 'Usable, but the tail is loose — expect occasional stutter. Check background tabs and power settings.'
        : 'Pacing is not good enough for a 1 kHz loop as configured. Check cross-origin isolation (Atomics backend) and CPU contention.';

  const maxBin = Math.max(1, ...r.histogram.map((h) => h.count));

  host.innerHTML = `
    <div class="verdict ${cls}">
      <strong>${r.tickInterval.hz.toFixed(1)} Hz effective</strong>
      · sd ${jitterSd.toFixed(3)} ms
      · p99 ${r.tickInterval.p99.toFixed(3)} ms
      · max ${r.tickInterval.maxMs.toFixed(2)} ms
      · stalls &gt;8 ms: ${r.stalls.over8ms}<br />${verdict}
    </div>
    <table>
      <thead><tr><th>series</th><th>n</th><th>mean</th><th>sd</th><th>min</th><th>p50</th><th>p90</th><th>p99</th><th>p99.9</th><th>max</th></tr></thead>
      <tbody>
        ${statRow('tick interval', r.tickInterval)}
        ${statRow('tick lateness', r.tickLateness)}
        ${statRow('device report', r.deviceReport)}
        ${statRow('frame interval', r.frameInterval)}
      </tbody>
    </table>
    <p class="hint">
      Device reported new data ${r.freshSamples.toLocaleString()} times in ${r.durationS} s
      (${r.deviceReport.hz.toFixed(1)} Hz) across ${r.polls.toLocaleString()} polls — polling faster
      than the radio reports costs nothing but buys nothing either.
      Ticker backend: <strong>${r.tickerBackend}</strong>, cross-origin isolated: ${r.crossOriginIsolated}.
    </p>
    <div class="hist">
      ${r.histogram
        .map(
          (h) =>
            `<div class="hist-row"><span>${h.label}</span><span class="hbar"><span style="width:${(h.count / maxBin) * 100}%"></span></span><span>${h.count.toLocaleString()}</span></div>`,
        )
        .join('')}
    </div>
    <div class="row" style="margin-top:12px">
      <button id="jitter-copy" type="button">Copy JSON</button>
      <button id="jitter-download" type="button">Download JSON</button>
    </div>`;

  $('jitter-copy').onclick = () => {
    void navigator.clipboard.writeText(JSON.stringify(r, null, 2));
  };
  $('jitter-download').onclick = () => {
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fpvsim-m0-jitter-${r.startedAt.replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
}

// ---------------------------------------------------------------- wiring

$('device-refresh').onclick = refreshDevices;
$<HTMLSelectElement>('device-select').onchange = (e) => {
  const idx = Number((e.target as HTMLSelectElement).value);
  const dev = GamepadPoller.list().find((d) => d.index === idx);
  if (dev) selectDevice(dev.index, dev.id);
  else poller.select(-1);
};

$<HTMLSelectElement>('mode-select').onchange = (e) => {
  applyModePreset(mapping, Number((e.target as HTMLSelectElement).value) as StickMode);
  buildChannelRows();
  persist();
};

$('calib-toggle').onclick = (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  if (calibrator.active) {
    calibrator.stop();
    btn.textContent = 'Calibrate endpoints';
    btn.classList.remove('active');
    let applied = 0;
    for (const ch of CHANNELS) {
      const m = mapping.channels[ch];
      if (m.axis >= 0 && calibrator.hasTravel(m.axis)) {
        m.min = calibrator.min[m.axis] ?? -1;
        m.max = calibrator.max[m.axis] ?? 1;
        applied++;
      }
    }
    detectMessage = `endpoints captured for ${applied}/${CHANNELS.length} channels`;
    persist();
  } else {
    calibrator.start();
    btn.textContent = 'Stop & apply';
    btn.classList.add('active');
    detectMessage = 'Sweep every stick to all four stops, then stop.';
  }
};

$('center-capture').onclick = () => {
  for (const ch of CHANNELS) {
    const m = mapping.channels[ch];
    if (m.axis >= 0) m.center = poller.axes[m.axis] ?? 0;
  }
  detectMessage = 'centres captured (release the sticks first)';
  persist();
};

$('mapping-reset').onclick = () => {
  clearMapping(mapping.deviceId);
  mapping = newMapping(mapping.deviceId, mapping.mode);
  buildChannelRows();
  detectMessage = 'mapping reset to preset';
};

$('jitter-start').onclick = startRun;

// Dev-only handle so the CDP check in tools/browser-check.mjs can drive the
// model without a radio attached. Stripped from a production build by the
// import.meta.env.DEV guard, so it cannot become a load-bearing API.
if (import.meta.env.DEV) {
  (globalThis as unknown as Record<string, unknown>).__fpvsim = { flight, poller, mapping, scene, tune, tabs, auxControl, racePanel };
}

// ---------------------------------------------------------- reset everything

{
  const btn = $<HTMLButtonElement>('reset-all-btn');
  const state = $('reset-all-state');
  let armedToReset = false;
  let armTimer: ReturnType<typeof setTimeout> | null = null;

  const disarmReset = (): void => {
    armedToReset = false;
    btn.textContent = 'Reset all settings';
    btn.classList.remove('confirm');
    if (armTimer !== null) clearTimeout(armTimer);
    armTimer = null;
  };

  btn.onclick = () => {
    // Two presses, not a confirm() dialog: this throws away a pilot's
    // calibration, which is the most tedious thing here to redo, and a
    // mis-click should not be able to do it. The arming lapses on its own so a
    // half-pressed button does not sit there waiting to be triggered later.
    if (!armedToReset) {
      const stored = describeStored();
      if (stored.length === 0) {
        state.textContent = 'nothing stored — already at defaults';
        return;
      }
      armedToReset = true;
      btn.textContent = 'Press again to erase';
      btn.classList.add('confirm');
      state.textContent = `will clear: ${stored.join('; ')}`;
      armTimer = setTimeout(disarmReset, 6000);
      return;
    }

    const cleared = clearStored();
    disarmReset();
    state.textContent = `cleared ${cleared.length} setting${cleared.length === 1 ? '' : 's'} — reloading…`;
    // Reload rather than rebuild in place: every panel reads its state once in
    // its constructor, so a live reset means a re-read path per panel that
    // exists for this button alone and is exercised by nothing else.
    setTimeout(() => globalThis.location.reload(), 350);
  };
}

globalThis.addEventListener('gamepadconnected', refreshDevices);
globalThis.addEventListener('gamepaddisconnected', refreshDevices);

buildChannelRows();
buildAuxRows();
refreshDevices();
requestAnimationFrame(render);
// Devices stay hidden until the browser sees activity; keep looking.
setInterval(() => {
  if (!poller.connected) refreshDevices();
}, 1000);
