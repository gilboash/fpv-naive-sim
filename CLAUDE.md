# fpvsim — working notes

## Status
Browser FPV simulator for skill training; brief accepted 2026-08-23. First
target: one 5" racing quad, a few simple maps with basic obstacles.

Remote: https://github.com/gilboash/fpv-naive-sim (pushed 2026-08-25).

**Phase M0 (input spike) complete and signed off 2026-08-25.** Vite +
TypeScript, no framework.
Next is M1: the 1 kHz flight model. Per the brief, do not move to art before
the feel is right.

## Layout
- `src/ticker.worker.ts` + `src/ticker-protocol.ts` — worker tick source. Atomics
  backend blocks in `Atomics.wait` and so is controlled through a
  SharedArrayBuffer, not messages; a worker in `Atomics.wait` never reaches its
  event loop. COOP/COEP are set in `vite.config.ts`.
- `src/gamepad.ts` — polling, axis detection, endpoint calibration. Hot path:
  no DOM, no await, reused typed arrays.
- `src/mapping.ts` — axis to channel, invert/endpoints/centre/deadband,
  localStorage persistence per device id.
- `src/jitter.ts` — interval statistics, percentiles over means.
- `src/main.ts` — wiring and DOM. Rendering is rAF at 30 Hz and is kept out of
  the input path.

## Next session starts here
State that is not derivable from the code or git history. Update this section
instead of relying on a chat transcript surviving.

**M0 is done and signed off (2026-08-25).** Built, typechecks, builds, verified
over CDP, and now measured on real hardware in a focused Chrome 147 window with
a Radiomaster TX16S attached. Raw results live in `measurements/`; the writeup
is in the README. Three bugs were found by verification rather than by reading:
the worker tick loop was recursive and overflowed the stack under the Atomics
backend; a jitter run could only terminate from a tick, so a dead ticker hung
the test; and the histogram labelled its buckets with `toFixed(0)`, collapsing
edges 1.1/1.5/2 into labels reading "0.9–1", "1–2" and "2–2 ms". All three are
covered by comments at the fix sites.

**The headline finding, and it shapes M1:** the tick source is fine — 1 kHz is
real, sd 0.062 ms, p99 1.175 ms, zero stalls over 8 ms in 60 s, and the windowed
run beat the headless floor on every statistic. But **the TX16S reports at
201.8 Hz, not 1 kHz** (mean 4.95 ms, one poll in five sees new data). So the
stick signal is a zero-order hold updated every ~5 ms, ~2.5 ms of mean
quantisation latency is spent before the flight model runs, and the report tail
is not clean: p99 9.13 ms is a dropped report and there was one 135 ms gap
(~27 consecutive missed reports) in the minute.

M1 must therefore hold the last stick value and keep integrating rather than
assuming a fresh sample per step. Do not design around a 1 kHz input.

**Open:** whether that 135 ms gap is the radio, the USB stack, or macOS HID
scheduling. One occurrence is not a pattern — repeat the run before concluding
anything. End-to-end input→photon latency is still unmeasured and per the brief
needs a photodiode or high-speed-camera rig.

**Next: M1, the 1 kHz flight model.** Blade-element rotors, Betaflight rates,
full PID loop. Not started. Per the brief this is where the project lives or
dies, and no art before the feel is right.

**How to verify a browser change without a human:** launch Chrome headless with
`--remote-debugging-port`, drive it over CDP from a node script (Node 22 has a
global WebSocket), collect `Runtime.exceptionThrown` and `Log.entryAdded`. Do
not use `--dump-dom --virtual-time-budget` — the page's rAF loop and 1 kHz
ticker never let virtual time idle, and Chrome hangs.

## Conventions carried over from ../genius-invester
Worth keeping, because they were learned the expensive way there:

- **Verify, do not assert.** "Deployed" means a check ran against the running
  thing, not that a command exited 0.
- **Make guarantees structural, not procedural.** Database triggers over
  discipline; a hashed file over a promise not to edit it.
- **A guard that hides a missing function is worse than the error it hides.**
  A `hasattr` fallback there silently fed an empty portfolio to a live model.
- **Anchored ignore patterns.** An unanchored `data/` in `.gitignore` matched
  every directory of that name at any depth and silently dropped two different
  datasets, weeks apart.
