/// <reference lib="webworker" />
/**
 * High-rate ticker. Lives in a worker because main-thread timers are clamped
 * (>=4 ms once nested) and throttled when the tab is not focused. The worker
 * sleeps in Atomics.wait when cross-origin isolation gives us
 * SharedArrayBuffer, and falls back to setTimeout(0) otherwise — the fallback
 * is measurably worse and the UI says which one is in use rather than hiding it.
 *
 * The worker only keeps time. Gamepad state can only be read on the main
 * thread, so each tick is a postMessage that tells main "poll now".
 */

import {
  CTRL_FUTEX,
  CTRL_PERIOD_US,
  CTRL_RUNNING,
  CTRL_WORDS,
  type ReadyMsg,
  type TickMsg,
  type TickerInMsg,
} from './ticker-protocol.ts';

const sab: SharedArrayBuffer | null = (() => {
  try {
    // Absent unless the document is cross-origin isolated (COOP/COEP).
    return new SharedArrayBuffer(CTRL_WORDS * 4);
  } catch {
    return null;
  }
})();

const backend = sab ? 'atomics' : 'timeout';
const ctrl = sab ? new Int32Array(sab) : null;

const MIN_PERIOD_MS = 0.05;
/** Resync rather than firing a burst after a long stall. */
const RESYNC_MS = 100;

let seq = 0;

function emit(scheduled: number): void {
  const msg: TickMsg = { type: 'tick', seq: seq++, scheduled, fired: performance.now() };
  self.postMessage(msg);
}

// ------------------------------------------------------------ atomics backend

/** Never returns. Control comes from the shared control words, not messages. */
function atomicsLoop(c: Int32Array): void {
  let next = performance.now();
  for (;;) {
    if (Atomics.load(c, CTRL_RUNNING) === 0) {
      // Idle: cheap 20 ms naps until main starts us.
      Atomics.wait(c, CTRL_FUTEX, 0, 20);
      next = performance.now();
      seq = 0;
      continue;
    }

    const periodMs = Math.max(MIN_PERIOD_MS, Atomics.load(c, CTRL_PERIOD_US) / 1000);
    if (performance.now() - next > RESYNC_MS) next = performance.now();

    // Bounded catch-up: never more than a few ticks per pass, so a stall
    // cannot turn into an unbounded burst of postMessages.
    let fired = 0;
    while (performance.now() >= next && fired < 8) {
      emit(next);
      next += periodMs;
      fired++;
    }

    const remaining = next - performance.now();
    if (remaining > 0.3) Atomics.wait(c, CTRL_FUTEX, 0, remaining);
  }
}

// ------------------------------------------------------------ timeout backend

let running = false;
let periodMs = 1;
let next = 0;

function timeoutLoop(): void {
  if (!running) return;
  if (performance.now() - next > RESYNC_MS) next = performance.now();

  let fired = 0;
  while (running && performance.now() >= next && fired < 8) {
    emit(next);
    next += periodMs;
    fired++;
  }
  // Iterative, not recursive: setTimeout unwinds the stack each pass.
  setTimeout(timeoutLoop, 0);
}

self.onmessage = (e: MessageEvent<TickerInMsg>) => {
  if (ctrl) return; // atomics backend is driven by the control words
  const msg = e.data;
  switch (msg.type) {
    case 'start':
      periodMs = Math.max(MIN_PERIOD_MS, 1000 / msg.hz);
      seq = 0;
      next = performance.now();
      if (!running) {
        running = true;
        timeoutLoop();
      }
      break;
    case 'setHz':
      periodMs = Math.max(MIN_PERIOD_MS, 1000 / msg.hz);
      break;
    case 'stop':
      running = false;
      break;
  }
};

const ready: ReadyMsg = { type: 'ready', backend, ctrl: sab };
self.postMessage(ready);

// Deferred so the ready message and the handler above are in place before the
// atomics loop takes the thread and never gives it back.
if (ctrl) setTimeout(() => atomicsLoop(ctrl), 0);
