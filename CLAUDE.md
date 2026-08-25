# fpvsim — working notes

## Status
Browser FPV simulator for skill training; brief accepted 2026-08-23. First
target: one 5" racing quad, a few simple maps with basic obstacles.

Remote: https://github.com/gilboash/fpv-naive-sim (pushed 2026-08-25).

**Phase M0 (input spike) built and verified.** Vite + TypeScript, no framework.
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

**Done:** M0 built, typechecks, builds, and was verified in a real browser over
CDP (no console errors, jitter run completes). Two bugs were found and fixed by
that verification: the worker tick loop was recursive and overflowed the stack
under the Atomics backend, and a jitter run could only terminate from a tick, so
a dead ticker hung the test. Both are covered by comments at the fix sites.

**Open, and blocking the M0 sign-off:** the published jitter number. The only
run so far is headless Chrome with no GPU, no compositor and no radio attached:
1000.0 Hz effective, sd 0.080 ms, p99 1.340 ms, max 7.44 ms, 0 stalls >8 ms over
60,034 ticks. That is a floor. The real number needs a 60 s run in a focused
window with the radio plugged in — hardware the agent environment does not have.
The `device report` row will be empty until then, and it is the row that says
whether the radio reports at 1 kHz or something slower.

**Not started:** M1, the 1 kHz flight model. Blade-element rotors, Betaflight
rates, full PID loop. Per the brief this is where the project lives or dies.

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
