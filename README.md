# fpvsim

Browser-based FPV drone simulator for skill training, flown with a real RC
transmitter over USB. See the project brief for the full scope; first target is
a single 5" racing quad and a few simple maps with basic track obstacles.

**Current phase: M0 — input spike.** Gamepad plumbing, channel mapping, and an
honest measurement of loop timing. No physics, no 3D scene. That is deliberate:
per the brief, M1 (flight model) is where the project lives or dies, and it
cannot be evaluated on top of an input path whose timing nobody measured.

## Run it

```
npm install
npm run dev      # http://localhost:5180 (or whatever Vite prints)
npm run build    # typecheck + production build
```

Put the radio in USB Joystick mode, plug it in, then **move a stick** — browsers
hide gamepads from a page until they see activity.

## What M0 gives you

1. **Device list** — every connected gamepad, with axis and button counts.
2. **Raw input view** — all axes to 4 decimal places, all buttons, live.
3. **Channel mapping** — per channel: detect-by-moving-the-stick, manual axis
   select, invert, deadband; plus endpoint calibration, centre capture, and
   mode 1/2/3/4 presets. Persisted in `localStorage` per device id.
4. **Jitter test** — a 60 s (configurable) measurement of the input loop.

## The timing architecture, and why

Main-thread timers are clamped to ≥4 ms once nested and are throttled outright
in a background tab, so the tick source is a **worker**. Where the page is
cross-origin isolated the worker sleeps in `Atomics.wait` and is controlled
through a `SharedArrayBuffer`, because a worker blocked in `Atomics.wait` never
reaches its event loop and would never receive a `postMessage`. Without
isolation it falls back to `setTimeout(0)`, which is worse; the UI names the
backend in use rather than hiding the difference.

Gamepads can only be read on the main thread, so the worker only keeps time:
each tick is a message that tells the main thread to poll. The poll happens in
that tick — not in `requestAnimationFrame` — and the path allocates nothing it
does not have to and awaits nothing. In M1 the physics step goes immediately
after the poll.

COOP/COEP headers are set in `vite.config.ts` for both `dev` and `preview`.

## Reading the jitter results

Four series are recorded:

- **tick interval** — time between successive loop ticks. This is the number
  that matters: `sd` and `p99`, not the mean, which is 1.000 ms by construction.
- **tick lateness** — how far past its scheduled time each tick fired.
- **device report** — interval between `Gamepad.timestamp` changes, i.e. how
  fast the radio *actually* reports. Polling faster than this costs nothing and
  buys nothing; it is worth knowing which side of 1 kHz your radio is on.
- **frame interval** — `requestAnimationFrame`, for reference only.

Keep the tab focused during a run. A background tab is throttled and the numbers
become meaningless.

### Baseline measured so far

| Run | Backend | Effective | sd | p99 | p99.9 | max | stalls >8 ms |
|---|---|---|---|---|---|---|---|
| headless Chrome, no GPU, **60 s**, no radio | atomics | 1000.0 Hz | 0.080 ms | 1.340 ms | 1.475 ms | 7.44 ms | 0 (60,034 ticks) |
| **Chrome 147, focused window, 60 s, TX16S attached** | atomics | 1000.0 Hz | **0.062 ms** | **1.175 ms** | 1.255 ms | 3.91 ms | 0 (60,112 ticks) |

Raw results are in `measurements/`.

The real run is *better* than the headless floor on every tick statistic — sd
0.062 vs 0.080 ms, p99 1.175 vs 1.340 ms, max 3.91 vs 7.44 ms. Headless Chrome
has no compositor to schedule against but also no display to pace to; the
windowed run gets a steady 60 Hz vsync and a warm scheduler. Tick lateness:
mean 0.209 ms, p99 0.255 ms, max 3.14 ms. 23 intervals exceeded 2 ms, none
exceeded 8 ms, and 57,823 of 60,112 landed in the 0.9–1.1 ms bucket.

**The tick source is not the problem.** 1 kHz on the main thread is real.

### The radio reports at 200 Hz, not 1 kHz

This is what M0 was built to find out, and it is the number that shapes M1:

| | value |
|---|---|
| device | Radiomaster TX16S Joystick (`1209:4f54`), 8 axes |
| report rate | **201.8 Hz** — mean 4.95 ms, p50 4.99 ms |
| tail | p90 5.99 ms, p99 9.13 ms, p99.9 20.0 ms, max **134.97 ms** |
| fresh samples | 12,132 new reports across 60,113 polls |

So roughly **one poll in five sees new data**. Polling at 1 kHz is still the
right thing to do — it costs nothing, it keeps the physics step on a fixed
clock, and it means the sim reacts within 1 ms of a report arriving rather than
waiting for the next frame — but the stick signal itself is a zero-order hold
that only changes every ~5 ms.

Two consequences for M1:

1. **~2.5 ms of mean quantisation latency is already spent** before the flight
   model does anything, and up to 5 ms worst case. That is a floor on
   stick-to-state response no amount of physics work can recover.
2. **The tail is not clean.** p99 of 9.13 ms is a dropped report (two periods),
   and the 135 ms maximum is roughly 27 consecutive missed reports — a real
   dropout, once in 60 s. M1 must not assume a fresh sample every step; hold
   the last value and keep integrating.

Whether the 135 ms gap is the radio, the USB stack, or macOS HID scheduling is
not yet known, and one occurrence is not a pattern. Worth a repeat run before
drawing conclusions.

Reference: `requestAnimationFrame` held 60.0 Hz (sd 0.38 ms) throughout, so
rendering was not stealing from the input path.

That covers loop pacing only. It is **not** end-to-end input→photon latency,
which per the brief still needs a photodiode or high-speed-camera rig.

## Related work on this machine

- `../genius-invester` — Flask + SQLite portfolio portal and a running
  pre-registered experiment. Worth reading for conventions rather than code:
  frozen parameters, append-only ledgers, and pre-committed criteria.
