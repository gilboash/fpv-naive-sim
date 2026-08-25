/**
 * Shared between the main thread and the ticker worker.
 *
 * With cross-origin isolation the two threads talk through a SharedArrayBuffer
 * rather than messages: the worker blocks in Atomics.wait for the whole run and
 * therefore never returns to its event loop, so postMessage-based control would
 * never be delivered. Main writes control words, the worker reads them each tick.
 */

/** Slot the worker sleeps on. Always 0; used only as a futex address. */
export const CTRL_FUTEX = 0;
/** 1 = tick, 0 = idle. */
export const CTRL_RUNNING = 1;
/** Tick period in microseconds. */
export const CTRL_PERIOD_US = 2;
export const CTRL_WORDS = 4;

export type TickerBackend = 'atomics' | 'timeout';

export interface TickMsg {
  type: 'tick';
  seq: number;
  scheduled: number;
  fired: number;
}

export interface ReadyMsg {
  type: 'ready';
  backend: TickerBackend;
  ctrl: SharedArrayBuffer | null;
}

export type TickerInMsg =
  | { type: 'start'; hz: number }
  | { type: 'stop' }
  | { type: 'setHz'; hz: number };
