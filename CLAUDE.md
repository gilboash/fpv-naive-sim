# fpvsim — working notes

## Status
Browser FPV simulator for skill training; brief accepted 2026-08-23. First
target: one 5" racing quad, a few simple maps with basic obstacles.

Remote: https://github.com/gilboash/fpv-naive-sim (pushed 2026-08-25).

**M0 (input spike) signed off 2026-08-25. M1 (flight model) built the same
day.** Vite + TypeScript, no framework. Per the brief, do not move to art
before the feel is right.

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
- `src/flight/` — the flight model. Pure TypeScript, no browser dependency, so
  it runs under `node --experimental-strip-types` with no build step. That is
  what makes the headless acceptance tests possible and it costs one rule:
  **no parameter properties, enums or namespaces in that directory**, because
  strip-only mode cannot compile them. Learned by writing them first.
- `src/flight-panel.ts` — instrumentation, not a scene. Owns its own DOM so
  `main.ts` needed only two lines: step in the tick, render at 30 Hz.
- `src/flight/recorder.ts` — flight recorder in Blackbox's field layout, so a
  sim flight and a real `.bbl` can be compared through one code path. Samples
  in the tick, exports off it.
- `tools/flight-check.ts` — 39 physical acceptance tests, `npm run check:flight`.
- `tools/browser-check.mjs` — CDP verification of the real page,
  `npm run check:browser`. Needs `npm run dev` running.

## Next session starts here
State that is not derivable from the code or git history. Update this section
instead of relying on a chat transcript surviving.

**M0 done and signed off (2026-08-25).** Measured on real hardware in a focused
Chrome 147 window with a Radiomaster TX16S: tick source holds 1 kHz, sd 0.062 ms,
p99 1.175 ms, zero stalls over 8 ms, and it beat the headless floor on every
statistic. Raw results in `measurements/`, writeup in the README.

**The M0 finding that shaped M1:** the TX16S reports at **~200 Hz, not 1 kHz**.
One poll in five sees new data, so the stick signal is a zero-order hold updated
every ~5 ms and ~2.5 ms of mean latency is spent before the model runs.

Two 60 s runs ten hours apart (both in `measurements/`) settle what is
reproducible and what is not:

- **Dropped reports are steady at ~2 per second.** p99 is almost exactly two
  report periods in both runs — 121 and 120 gaps in 60 s. This is the link's
  normal behaviour, not an outlier.
- **The extreme tail does not repeat.** Run 1's 135 ms gap (~27 consecutive
  missed reports) did not recur; run 2's worst was 34 ms. Expect tens of
  milliseconds roughly once a minute, worst case unpredictable from one run.
- The cause is still unknown — radio, USB stack, or macOS HID scheduling. Two
  runs give the rate, not the mechanism, and nothing reachable from the browser
  can see deep enough to tell. Treat this as closed for planning purposes and
  open for curiosity.

The model holds the last stick value and keeps integrating, never assuming a
fresh sample per step, and the panel disarms on link loss. Both follow from the
table above rather than from good intentions.

Incidentally, run 2 is also the first independent confirmation of the histogram
label fix — its buckets read 0.9-1.1 / 1.1-1.5 / 1.5-2 rather than the collapsed
"0.9-1 / 1-2 / 2-2 ms" of run 1.

**M1 built and verified (2026-08-25), not yet signed off.** Blade-element
rotors, electrical brushless motors with battery sag, Betaflight-scaled PID with
Betaflight rate curves, geometry-derived quad X mixer with airmode, 6-DOF rigid
body at 1 kHz stepping inside the input tick. Costs 3.5 us of the 1000 us
budget. 39 headless acceptance tests and 10 CDP browser checks all pass.

Three bugs came out of testing rather than reading, and all three are commented
at the fix sites: effective motor resistance was the winding figure alone and
drew 290 A at full throttle; roll inertia was a parts estimate that came out
below every published measurement for the class; and there was no gyro clipping,
so the model had perfect knowledge of its own rotation in exactly the tumble
where a real quad's gyro is railed at 2000 deg/s.

Two of the tests were also wrong in an instructive way. Static thrust was being
measured while the quad climbed away at 30 m/s, which is a real effect but not
what a thrust figure means. And the airmode test compared achieved roll rate
with and without airmode, found no difference, and was measuring the controller
rather than the mixer — the PID simply winds up until a clipped mixer delivers
anyway. Both are noted in the test file.

**Open, and blocking M1 sign-off: no Blackbox comparison.** The model is
physically principled and internally consistent, but nobody has put a log from a
real 5" quad beside it. That is the same shape of gap the published jitter
number was in M0, and it wants the same treatment — a real log, from the real
radio, flown by the person who knows what it should feel like. Until then no
claim about "feel" is supported by anything but the physics.

Also open: end-to-end input-to-photon latency is still unmeasured and needs a
photodiode or high-speed-camera rig. The report-gap question from M0 is now
answered as far as it usefully can be — see the two-run comparison above.

**Next, and the reason the recorder exists:** a comparison harness that reads a
Betaflight Blackbox log and a sim recording through one path, drives the model
with the logged `rcCommand` at 1 kHz, and plots achieved against logged gyro per
axis. Gilboa has been asked for: the `.bbl`, a `diff all`, and the physical
measurements (all-up weight with battery, prop, motor KV, cells, pack capacity,
motor-to-motor diagonal). Bidirectional DShot matters more than any debug flag —
it puts per-motor RPM in the log, which is what separates the motor model from
the rotor model from the PID.

**After sign-off:** M2, the scene. Not before the feel is right.

**How to verify a browser change without a human:** `npm run check:browser`,
which is the M0 technique packaged — headless Chrome with
`--remote-debugging-port`, driven over CDP from Node (22 has a global
WebSocket), collecting `Runtime.exceptionThrown` and `Log.entryAdded`, then
reading state back out of the page rather than assuming silence means success.
Do not use `--dump-dom --virtual-time-budget`: the rAF loop and the 1 kHz ticker
never let virtual time idle and Chrome hangs. `SCREENSHOT=/path/x.png` on that
command captures the page.

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
