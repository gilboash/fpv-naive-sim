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
- `src/flight/blackbox.ts` — Betaflight binary decoder, `tools/identify.ts` —
  airframe parameter fitting from a log, `npm run identify`.
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

**First recorded flight (2026-08-25, in `measurements/`, gzipped)** found two
things the 41 acceptance tests did not: a 92 A per-motor transient, now capped
by `MotorSpec.maxCurrent` at 55 A; and ~17% airborne overshoot on full-stick
flicks, against the 6.8% the step test measures on a gentler 234 deg/s step.
The second is unresolved and is a question for the Blackbox comparison, not a
bug to chase blind. Two things that looked wrong and were not: motors at zero
output 67% of the time is airmode working, and the worst single number in the
log came from the ground model at 0.1 m altitude.

That flight also spent half its time within 0.5 m of the ground and hit it at
27 m/s without consequence, so the missing crash model is now demonstrated
rather than theoretical. Still a later milestone, but it is the gap most likely
to be felt next.

**Comparison harness built (`tools/replay.ts`, `npm run replay`).** Reads our
recordings and `blackbox_decode` CSV through one path, with every unit
assumption printed rather than buried. Building it before the log arrived paid
for itself immediately:

- **Whole-flight replay validates nothing.** The model reproduces its own
  recording exactly while disarmed and diverges within 10 ms of arming. Stick
  quantisation of 1e-4 — finer than any radio — gives 1 deg/s in 33 ms. The
  system is chaotic and mixer saturation is a real discontinuity. Had this been
  discovered while staring at a real log, the obvious conclusion would have been
  "the model is wrong", and it would have been false.
- **So: windowed comparison**, 250 ms segments seeded from logged state, with a
  50 ms run-in during which rates and rotor speeds are pinned to the log so the
  controller's filters charge on real history. A single-sample seed was 13% out
  on motor output at the first step, because the D-term filter started at zero.
- **Ground windows must be excluded.** Half the first flight was within 0.5 m of
  the ground, where the reference's contact damping scales body rates by 0.6 per
  step. Including them was drowning the airborne signal entirely.
- **The floor is ~3 deg/s at 10 ms, ~10 at 25 ms, ~20 at 100 ms.** Useful
  horizon is 25-50 ms. `--scale-inertia` says doubling roll inertia roughly
  triples the 200 ms error, so the method catches gross errors and not 10% ones.
  Yaw discriminates best, being least disturbed by saturation.

**Blackbox decoder written (`src/flight/blackbox.ts`).** `blackbox_decode` is
not installable here and Homebrew does not carry it, and a pipeline with a
mandatory GUI export in the middle fails this project's own convention. Decodes
all four of Gilboa's logs with zero desyncs. Two bugs worth remembering: after an
I frame both history slots must hold it (otherwise the first straight-line
prediction is garbage and the rest of the file byte-scans), and TAG8_4S16's
16-bit values are big-endian while the rest of the format is little-endian.

Also: I broke the no-parameter-properties rule from the Layout section above
while writing it, within a day of writing the rule down. It is a real constraint,
not a style note.

**First real comparison run (2026-08-26).** Six flights across two quads,
NACRONOS (MAMBAF722, 6S, 2 kHz logging, eRPM present) being the best — a 117 s
flight. The tune is read straight out of the header, so the model runs on their
gains. `rates_type:2` is KISS, which is algebraically identical to the
Betaflight curve for ordinary expo; verified against the logged setpoint, which
the Actual curve misses by 372 deg/s.

**Result: the model measurably differs from the real quads.** Median per-window
RMS 11-32 deg/s in roll, 10-21 pitch, 7-9 yaw, against a per-flight chaos floor
of 0.0-0.8. So 20x to 600x the floor: real signal, not noise.

This nearly went the other way. Compared against the floor from the aggressive
sim flight (roll 31.6), five of six real logs looked *better than a perfect
model*. The floor is a property of how hard the reference was flown, not of the
method, so it is now measured per log by re-flying each window with the sticks
nudged one quantum. Any floor quoted from a different flight is meaningless.

**NACRONOS specs received and modelled (`kronos()` in airframe.ts):** Kronos
Legacy frame, 250 g dry + 220 g pack = 470 g AUW, 6S 1480 mAh 160C, Gemfan
51377, 2107 motors at 2080 KV.

**Betaflight logs pitch positive nose-down.** The reader negates it. Established
from data, not source, and the method matters: the motor *command* differential
correlates +0.41 with pitch acceleration and the eRPM-derived *thrust*
differential correlates -0.50, at zero lag, on the same flight where roll gives
+0.49 both ways. The command has a PID in the loop; thrust does not. Applying
the flip cut pitch error 20-32% and left roll and yaw alone.

**`tools/identify.ts` measures airframe parameters from a log** (needs
bidirectional DShot). Results on NACRONOS: thrust coefficient 1.148e-6
N/(rad/s)^2 against a modelled 1.64e-6 — the blade-element model was 43% high,
but flatly so across 6 000-26 000 rpm, meaning the omega-squared law was right
and only the aerodynamic scale was wrong. clAlpha 5.7 (thin-aerofoil theory) is
not achievable at prop Reynolds numbers; 3.7 with cd0 0.035 matches. Roll
inertia fitted 1.759e-3 against a 1.8e-3 estimate; pitch fitted 8.4e-4, half of
roll, which is suspicious for a symmetric frame and is the weaker fit.

Two filter traps in that tool, both now commented: a quad on the ground is
level, still, and reads exactly 1 g, so hover detection needs a throttle gate;
and a racing quad never actually hovers, so the thrust fit runs over the whole
flight using the fact that body-z specific force *is* rotor thrust over mass.

**The comparison is not yet sensitive to airframe parameters.** Swapping the
generic racer for the measured Kronos barely moves the result. Windowed replay
seeds rotor speed and I-term from the log, and a rate-mode PID compensates for
airframe error over 250 ms. So the residual 20/13/7 deg/s is elsewhere, and the
candidates are all unmodelled Betaflight features: d_min (active, 21/30/0
against d_max 37), anti-gravity (gain 80), the dynamic gyro lowpass, and RC
smoothing shaping the setpoint. Those are the next things to try.

What remains when the specs land: Gilboa has been asked for: the `.bbl`, a `diff all`, and the physical
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
