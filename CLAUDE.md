# fpvsim — working notes

## Status
Browser FPV simulator for skill training; brief accepted 2026-08-23. First
target: one 5" racing quad, a few simple maps with basic obstacles.

Remote: https://github.com/gilboash/fpv-naive-sim (pushed 2026-08-25).

**M0 signed off 2026-08-25. M1 signed off 2026-08-26.** Vite + TypeScript, no framework. Per the brief, do not move to art
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

**Residual worked down (2026-08-26).** The error decomposition — bias, gain,
lag, shape, per window — is what made this tractable: "too soft and 13 ms late,
on every axis" is a lead, where "20 deg/s RMS" is not. Net result: roll error
down 20-28%, yaw down 27-29%, lag essentially gone on roll and pitch.

Three real defects found, all invisible to the 43 synthetic tests:

1. **Feedforward was 100x too strong.** Betaflight uses
   `Kf = FEEDFORWARD_SCALE * (F / 100)`; P, I and D take their value directly.
   The pidSum clamp hid it — the term saturated and the step response still
   looked fine.
2. **Motor four times too slow.** Time constant is `J*R/ke^2`; estimates gave
   49 ms, the logs measure 11.5 ms (`tools/identify.ts` fits it from ESC command
   steps against eRPM).
3. **Battery was charged motor current, not pack current.** An ESC is a
   switching converter: pack current is `duty x motor current`. An inflated
   winding resistance had been compensating for this, which is exactly what made
   the motor four times too slow. One bug was hiding the other, and fixing
   either alone would have looked like a regression.

Also added: RC smoothing on the setpoint (Betaflight has it; without it the
staircase from a 200 Hz radio into a 1 kHz loop spikes the feedforward), D_MIN,
and a `setpointOverride` on FlightSim for driving replay from a logged setpoint.

**M1 SIGNED OFF 2026-08-26.** Validated against NACRONOS: four independent
measured quantities reproduced with one fitted aerodynamic constant (hover rotor
speed 9 428 vs 9 568, hover pack current 6.2 vs 6.4 A, full throttle 28 046 vs
28 286 rpm, peak pack current 280 vs 278 A). Rate response over three real
flights: RMS 13.9-21.0 roll, 8.8-11.7 pitch, 3.9-8.2 yaw; lag 0-5 ms on roll and
pitch. Roll error fell 39% and lag went from 18 ms to under 5 over this work.

Signed off with a known, quantified gap rather than as correct: **timing is
right, amplitude is not.** Gain 0.74-0.86 roll, 0.62-0.86 yaw, 0.44-0.54 pitch.
Gilboa's call was to finalise M1 and fine-tune as more data arrives, which is
the right call — the remaining gap needs data this project does not have.

**Still open, and quantified:** gain 0.48-0.83, so the model still responds too
softly, worst in pitch. Prop torque coefficient is ~1.7x low against the logs
(3.0e-8 duty-corrected vs 1.45e-8 modelled), which also puts hover current at
the bottom of the measured range (3.0 A model, 6.4 A median measured on a
lighter quad) and overspeeds full throttle to 38 000 rpm against a logged
28 300. Matching by cd0 alone needs 0.19, four times any real aerofoil, so some
of the measured torque must be motor and ESC loss misattributed to the prop.
Deliberately not fudged. Anti-gravity still unimplemented. Yaw keeps 9-18 ms of
lag that roll and pitch have lost.

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

**M2 (the scene) built 2026-08-28.** `src/render/` — WebGL2, one shader, two
draw calls, three maps, no dependency. Renders every rAF; text panels stay at
30 Hz. Frame conversion NED/FRD -> Y-up happens once, in `renderer.ts`, and
nowhere else.

Three bugs, none of which threw: the camera basis was not orthonormal (body-up
about the tilt axis is `(-sin t, 0, -cos t)`, and `+sin t` gave forward·up =
0.766, which shears the view — there is a test for it now); seven identical
gates in a line nest behind each other so the pilot sees one; and the ground
chequer's two greens differed by 0.03, leaving no speed cues at all.

The browser check now reads pixels back and asserts the frame is not a flat
fill — `SceneView` degrades gracefully when WebGL is missing, so an
error-watching check passed while nothing was being drawn. Headless needs
`--use-angle=swiftshader --enable-unsafe-swiftshader`.

**Pilot report, 2026-08-28, and the bug it found.** Gilboa flew M2 and reported
that roll and pitch felt like angle mode — a small input released at low
throttle made the quad shake as if self-levelling. It is not angle mode (with
sticks centred the model holds 60 degrees of roll and rotates at exactly zero)
but the report was otherwise right: the recording shows a 4 Hz damped
oscillation with sticks centred, ringing 400-600 ms, every instance at zero
throttle.

**Cause: the simulator was flying the uncalibrated airframe.** `FlightPanel`
constructed a bare `FlightSim()`, which defaults to `racer5()`, while every
parameter measured from the logs had gone into `kronos()`. So the whole Blackbox
calibration effort had been landing on an airframe the product did not use.
Settling at zero throttle went from never to 81 ms once fixed.

That is the lesson worth keeping: **a calibration is worthless if the thing
calibrated is not the thing flown**, and no test caught it because every test
constructs its airframe explicitly. Ten minutes of a pilot flying it did.

Also fixed: `defaultMotor()` still carried the inflated 0.13 ohm resistance that
had been standing in for the pack-current bug (time constant 41 ms against a
measured 11.5). And Betaflight's `iterm_windup` anti-windup is now implemented —
it was not the cause here, since the mix range never nears the windup point at
low throttle, but it was genuinely missing.

**Rates UI built 2026-08-28**, prompted by Gilboa asking where he entered his
rates. He could not: the model flew `defaultRates()` at 800 deg/s full stick
against his quad's 512, while matching almost exactly at centre (228 vs 221),
which is why it felt broadly right and no test caught it. Section 6 now edits
both curves per axis with live centre/max/shape, persists to localStorage, and
imports a whole tune — rates, PIDs, filters, feedforward, D_MIN — from a
Blackbox header in 11 ms on a 16.8 MB file (`readHeaderOnly`, text only, never
touches the frames). `tuneFromHeader` in `src/flight/tune.ts` is shared with the
log reader so the two cannot drift.

**Rates units and KISS, 2026-08-28.** Gilboa pointed out that the panel showed
the wrong units and the wrong fields. Two real bugs:

1. The panel displayed Betaflight's internal storage values, so a tune reading
   1.05 / 0.59 / 0.01 in a configurator showed as 105 / 59 / 1. Fields and units
   now follow the selected curve, via `RATE_FIELDS` in rates.ts. Conversion
   happens in the UI and nowhere else.
2. **KISS is not the Betaflight curve.** An earlier note in this file said they
   were algebraically identical; that is only true when expo is near zero, which
   was the case for NACRONOS (expo 1) and is not the case generally. With expo
   40 they are 8% apart at half stick. KISS is now its own implementation:
   it shapes with cmd^3 where Betaflight uses cmd*|cmd|^3, and has no
   incremental boost above RC rate 2.

**Collision built 2026-08-28** (`src/flight/collision.ts`). Penalty contact at
four points under the arms — spring-damper along the normal, Coulomb across it —
against a ground plane plus cylinder and box obstacles in NED. Tracks emit the
volumes from the same call that builds the mesh, so drawn and solid cannot
diverge. Replaces the old clamp that pinned the CG and scaled body rates by 0.6
every step.

Resting, sliding, tipping and tumbling all fall out of the same code with no
special cases; set down at 45 degrees it falls flat, which a clamp could not do.
Hard impacts set `crashed`, disarm, and keep simulating. Scenery crashes at a
third of the ground's threshold, because a post takes a prop off.

`FlightPanel.onReset` delegates reset to the scene so R returns the quad to the
start line rather than the origin — delegation rather than a second key handler,
so the outcome does not depend on listener order.

Recovery is one key: R puts the quad back on the start line already armed, if
the throttle is down. Arming a wreck is refused. Both came from Gilboa asking
how to reset and then pointing out that having to re-arm was friction — until
then arming a wreck succeeded and left the flag stuck on.

That chase found a real failsafe hole: with no device the poller returns early
leaving its axes untouched, and a raw zero on a *unipolar* channel is mid-travel,
so a vanished radio read as 50% throttle. Nothing flew away because the failsafe
disarms, but everything downstream was told the pilot held half throttle. No link
now means no input, explicitly, in main.ts.

Note for browser checks: Gilboa's Radiomaster is plugged into this machine and
headless Chrome sees it, so `poller.connected` is true there and the axes are
live but uncalibrated. Force the disconnected case with `poller.select(-1)`
rather than assuming headless has no gamepad.

**Circuit is the default map (2026-08-29)** and carries freestyle furniture —
floodlight masts, two tubes, three elevated square windows — added for a round
of feedback from other pilots. Reset defaults to respawning in place, **on the ground**. Respawning in mid-air
shipped first and was a crash loop: the throttle must be down to re-arm, so
1.5 m of free fall lands at 5.2 m/s against a 4.5 m/s threshold and crashes
again inside 600 ms — press reset, watch it drop, cannot fly. Tested now.

A trap worth remembering: two browser checks broke when the circuit became the
default, because they `reset()` to the origin and the circuit has a tube
directly overhead there. They climbed into it, crashed, disarmed and fell back,
reporting a net climb of zero — a puzzling failure about entirely the wrong
subsystem. Flight-model checks now clear `sim.obstacles` first.

## Radio control, tabs and the quad instrument (2026-08-30)

**Aux switches** (`src/aux-control.ts`, `src/mapping.ts`): arm and reset bind to
an axis or a button. Arm is a **level**, as on a flight controller; reset is an
**edge**. A switch already on at page load will not arm until seen off once, and
link loss drops both the level and that guard — a reconnection re-earns it.
Storage is v3; the migration adds unbound aux and touches nothing else, with a
test asserting a v2 mapping keeps its endpoints, centre and inversion.

**Three tabs** (`src/tabs.ts`), split by *moment* rather than by subject: go fly
is everything live (view, sticks, arm/reset, battery/altitude/speed/current,
recorder), settings is pre-flight setup, instruments is checking and tuning
(stick check, rates, PIDs, response bars). `FlightPanel` takes three hosts for
this reason — the flying numbers were previously buried among the tuning ones. Only the visible
tab renders — two GL contexts drawing invisible frames is pure waste — but the
physics is deliberately unaffected, because it runs on the worker ticker rather
than rAF. There is a test that the quad keeps flying while the fly tab is
hidden, since freezing it would be the obvious wrong fix.

**The stick check** (`src/render/quad-view.ts`) replaces the artificial horizon.
It is driven by the *sticks*, not by simulator state — Gilboa's point, and the
right one: an instrument pointed at the flight model just repeats the FPV view,
whereas a stick-driven model verifies the channel mapping, which is where the
real bugs have been. It integrates like acro — sprang back to level
in a first version, which is angle mode and the one thing this simulator is not.
A `Level it` button covers getting lost. Throttle drives
prop speed only, so that channel is checkable too without the quad moving.

Shares the MeshBuilder and matrix helpers with the scene renderer; five draws
(airframe plus four props) with the model transform folded into the MVP, so the
shader needed no model matrix.

Two things worth keeping from building it:

- **I got the camera cross product wrong again**, the same error as the scene
  renderer's basis bug — the quad rendered mostly off the bottom of the frame.
  There is now an orthonormality test for this camera too. A wrong basis draws a
  picture; it just shears it.
- **Prop spin is a fixed idle-plus-throttle rate, not a rotor speed.** Driving
  it from real rpm aliased badly — 10 000 rpm is 167 rev/s, nearly three
  revolutions per frame at 60 fps, a wagon-wheel that crawls or reverses with
  throttle. It is an indicator and is commented as such.

**Stick overlay** (`src/stick-view.ts`) sits on the FPV view and follows
`mapping.mode`, because hard-coding mode 2 would lie to anyone else — and the
mode presets are already known-unreliable. Throttle rests at the bottom of its
gimbal, being unipolar.

**PID and filter editing** lives in Instruments while rates stay in Settings,
but `TunePanel` still owns both and both DOM trees: they are one tune and one
storage key, and two panels writing `fpvsim.tune.v1` would race and would leave
the Blackbox import updating only half. Applying is debounced ~700 ms because
`applyTune()` rebuilds the controller, restarting I-terms and filters.

**Two sign bugs in the stick check, both found by a pilot rather than by 94
tests (2026-08-30):** it sprang back to level (angle mode), and pitch was
reversed. The pitch one is instructive — `setModel`'s pitch argument was
nose-DOWN positive because the nose is drawn at -z, while its own comment
claimed nose-up, so I negated a command that already agreed. **Derive the sign
from the geometry, not from a comment.** There are now direction tests reading
the model matrix for all three axes.

Also: attitude and physics-cost readouts moved to the flying tab, since they
describe the live flight — the same rule that put battery and speed there.

## Race mode (2026-08-30)

**A race belongs to a map** (`Track.course`). Shipped without that binding and
the result was thoroughly confusing: the timer ran `sixGateCourse` whatever map
was loaded, so starting a race on another track drew checkpoint outlines hanging
in mid-air over ground with no gates on it. The Start button is now disabled on
a map with no course, and changing map stops the race and clears the marker.

**The chosen map was persisted by index**, so inserting `raceField` at position
0 silently repointed everyone's saved setting at a different track — which is
how Gilboa ended up looking at floating markers in the first place. Stored by
name now, with a migration from the index era. *An index is not an identifier.*

A test asserts the drawn gates and the timed gates coincide: every checkpoint's
nearest post is exactly one half-width away. That was always true — the mesh is
built from the checkpoint list — but it is the invariant the whole thing rests
on and it was untested.


`src/race/course.ts` (what a course is) and `src/race/race.ts` (sequencing and
timing), stepped from the 1 kHz tick beside the physics. `src/race-panel.ts` is
the UI, on the flying tab.

**The track is drawn from the checkpoint list the timer uses** — `sixGateCourse`
is the single source for both, so drawn and timed cannot diverge. Same principle
as the collision volumes coming from the mesh build.

**Timing is interpolated, not sampled.** The crossing fraction along the segment
is known, so the split is timed to the crossing rather than to the tick that
noticed it: exact to 1e-6 s in the tests, against ~1 ms of avoidable jitter.

**A respawn voids its lap** (`race.invalidateLap()`, wired to `flight.onReset`),
or a reset at the right moment is a shortcut. Invalid laps also break a
best-of-three run rather than being skipped over.

**The flag is a one-sided plane crossing**: go past the pole, this way, on this
side, within `passWidth`. Same test a gate uses.

It was a swept angle first — inside a radius, turn 270 degrees the right way —
and Gilboa found it both unclear and unpassable. Unclear because a circle drawn
on the ground says "fly this shape" when the shape was never the point.
Unpassable because flying round the drawn ring strayed outside the radius, which
silently reset the sweep, so it never completed however many laps he flew. **A
rule you can satisfy and still fail is worse than a hard one.**

Direction and side still matter, so circling the pole completes it only if the
circle passes on the required side — tests for both halves, plus wrong side, too
wide, and backwards.

**Race OSD and next-gate marker (2026-08-30)**, all three from Gilboa flying it:

- **Timing had to be on the video.** In fullscreen the picture is all there is,
  so a lap time in a panel underneath does not exist. `src/osd.ts` overlays
  clock, lap, next checkpoint, last lap, battery, altitude and speed on the
  stage — which is also what goes fullscreen, so it comes along.
- **Nothing said which gate was next.** `Renderer.setNextCheckpoint()` outlines
  the checkpoint itself — a gate's aperture with an arrow through it, a flag's
  circle with direction chevrons — unlit and depth-test off so it shows through
  the gate's own bar. Deliberate cheat: a HUD element in world space.

  The first attempt floated an arrowhead *above* the gate and Gilboa's verdict
  was that it was unclear, which it was: a shape in the air names no gate, shows
  no aperture and gives no direction. Fixing it also turned up a swapped axis —
  the across-aperture vector in render space is `(dirN, dirE)`, not
  `(dirE, dirN)`, and the wrong one drew the frame across the direction of
  flight, a skewed sliver rather than a rectangle.
- **The stick check now turns at the pilot's real rate curve** rather than a
  made-up constant, with deg/s and rpm beside it, so it verifies the rates too.

That last one exposed a real bug: `level()` reset the matrix but not the frame
clock, so returning to the Instruments tab snapped the model through a large
rotation on the first frame. Caught because the rate test was not monotonic.

**Next, roughly in order:**

1. **Map generation** — the half of "laps and maps" still outstanding. Race mode
   landed 2026-08-30 on a hand-built six-gate course.
2. **Respawn from the last gate passed** — the third variant, and the only one
   still missing. *In place* landed 2026-08-29 and is now the default, ahead of
   the pilot feedback round; *start line* is the selector's other option. The
   part still worth designing rather than bolting on is that a respawn has to
   invalidate the lap, or the timing added in step 1 measures nothing — so this
   and lap timing are entangled and should be built together.
3. **Motor sound.** A real flight cue: pilots hear throttle and RPM before they
   see the response. The model already produces per-rotor RPM, so this is
   probably the largest immersion-per-effort item left.
4. **An OSD** — battery, timer, speed.
5. **Lens distortion.** The projection is rectilinear where real FPV cameras are
   wide and barrel-distorted; currently mitigated by keeping the FOV modest.

**The fine-tuning loop, which is now the standing process:** more logs arrive ->
`npm run identify` for airframe parameters -> `npm run replay` for the rate
comparison -> read the gain/lag/shape decomposition, not the RMS. Everything
needed is in the repo and needs no human in the loop except to fly.

**What would actually move the remaining gap**, in order:
1. A thrust-stand run on a Gemfan 51377, or motor efficiency data for the 2107.
   That splits propeller drag from motor loss, which no flight log can.
2. Anything that explains pitch. Its inertia fits at under half of roll's on a
   square frame, and it is the worst axis for gain. Same unknown, probably.
3. Anti-gravity, still unimplemented.
4. Gilboa flying the sim with the TX16S and saying what feels wrong. The metrics
   are a proxy; the brief is about feel. If the two disagree, feel wins.

**How to verify a browser change without a human:** `npm run check:browser`,
which is the M0 technique packaged — headless Chrome with
`--remote-debugging-port`, driven over CDP from Node (22 has a global
WebSocket), collecting `Runtime.exceptionThrown` and `Log.entryAdded`, then
reading state back out of the page rather than assuming silence means success.
Do not use `--dump-dom --virtual-time-budget`: the rAF loop and the 1 kHz ticker
never let virtual time idle and Chrome hangs. `SCREENSHOT=/path/x.png` on that
command captures the page.

## Page layout for visitors (2026-08-29)

Five numbered sections in the order a pilot needs them — device, mapping, FPV
view, rates, instruments — with raw axes and the jitter test folded into a
collapsed Diagnostics block at the bottom. They still work; the elements keep
their ids so every binding in main.ts is untouched, and a closed `<details>`
still has its children in the DOM.

Renumbering touches three places that reference section numbers: the start-here
paragraph in index.html, and the uncalibrated-throttle notice in main.ts. Grep
for `· Channel` before assuming a renumber is complete.

Also removed: a `console.log` that dumped the whole jitter result on every run.
`__fpvsim` was already compiled out of production by `import.meta.env.DEV`,
confirmed by grepping the built bundle for it.

## Pitch is nose-down positive (2026-08-29)

Every pilot in the feedback round had to invert pitch by hand. That settles it
as a **convention** error rather than a preset one: the model used the aviation
convention, positive nose-up, where Betaflight and therefore every FPV pilot's
muscle memory has positive nose-down.

The control path — stick, setpoint, gyro, mixer — now runs in the pilot's
convention. The rigid body underneath keeps standard FRD, because every cross
product and quaternion integration depends on it, and `sim.ts` converts once
where the gyro enters the controller. `attitude.pitch` stays nose-up positive,
because that is what an artificial horizon means.

**Both negations are load-bearing.** The gyro negation in sim.ts and the mixer's
negative pitch coefficient close the same loop; removing either alone makes the
pitch axis diverge — 1894 deg/s replay error, and I tried it. Removing both
restores the old convention. There is no middle position.

Three things this cost, each worth remembering:

- **The sign tests could not catch it.** They all compare an achieved rate
  against a setpoint, which passes under a whole-model flip. There are now
  tests that fly the quad and check *where it goes* — and one that starts from a
  raw axis value of -1 and goes through `computeCommands`, which is the only
  kind that could have caught the original report.
- **`tools/replay.ts` seeds `sim.omega` directly from the log**, and omega is
  FRD (nose-up positive) while a gyro channel is nose-down positive. Missing
  that flip doubled the pitch replay error while leaving roll and yaw untouched,
  which is exactly the signature to look for.
- **I flipped the mapping preset twice**, once by reasoning "stick away is
  negative and nose-down is positive, so they agree" — which has the arithmetic
  backwards. Forward stick reads -1 and must produce a *positive* command, so
  pitch is inverted, like throttle. Fly it; do not reason about it.

Storage bumped to v2 with a no-op migration: the flip in the model and the flip
in the fix cancel, so a pilot's hand-set invert is still correct. The bump
records that this was checked.

## Stick presets are a guess (2026-08-29)

Gilboa had to tick invert on pitch by hand or forward stick flew him backwards.
The flight model is not at fault and is self-consistent — positive pitch command
is nose-up, asserted by a test, and the pitch negation in `logio.ts` is
reader-only and never touches live input. The **mode presets** were wrong:
pitch had `invert: false` where a stick axis reads negative pushed away, exactly
as throttle does, and throttle had always been `invert: true`.

Flipped in all four modes. That is one Radiomaster rather than a survey, so if
another radio contradicts it, believe the radio: `Detect` reads the direction
the pilot actually moved and is the only authoritative thing here. EdgeTX
applies the stick mode in the radio and emits AETR, so the preset axis *numbers*
are frequently wrong too.

## Hosting for other pilots (2026-08-29)

Gilboa wanted 2-3 pilots to try it remotely. It is entirely client-side —
verified, no network calls of any kind, four files and ~80 KB — so the host does
nothing per pilot. Three things had to be fixed first, all of them silent:

- **Vite blocks tunnel hostnames.** It answers only to localhost and bare IPs
  unless told, and skips that check only over HTTPS; a tunnel arrives over plain
  HTTP with the public hostname. Confirmed by curl: `403 Blocked request`.
  `preview.allowedHosts` now allows `.trycloudflare.com`, overridable with
  `FPVSIM_ALLOWED_HOSTS`. Not `true` — Vite's docs call that a DNS-rebinding
  exposure.
- **`poll()` called `navigator.getGamepads()` unguarded** at 1 kHz. Chrome does
  not expose the API on insecure origins, so sharing over plain http on a LAN
  threw a thousand times a second. Guarded, with `GamepadPoller.apiAvailable`
  so the UI can tell "no radio" from "this browser will never show you one".
- **Degradation was legible only as a pill.** `isolated: no` means nothing to a
  visiting pilot, so there is now a banner in words for a missing Gamepad API,
  for lost isolation, and for the first-run dead end where an uncalibrated
  throttle reads 50% and arming is refused for a reason that sounds like the
  pilot's fault.

`tools/browser-check.mjs` now takes any URL. The deep checks need the dev-only
debug handle; against a production build it degrades to a smoke test and reports
isolation as a warning rather than a failure, since that is the host's property
and not the build's.

Still unmeasured: what the `setTimeout` fallback actually costs. Every jitter
figure in the README is the atomics backend and the fallback is described as
"measurably worse" on no evidence. A 60 s run against the plain static server on
:8099 would settle it.

## Deployed on the Windows desktop (2026-08-29)

`./deploy-windows.sh` with `SSHPASS` set. Same host as genius-invester
(`gilboash@hotmail.com@192.168.7.54`), destination `C:\Users\gilbo\fpvsim`,
serving **127.0.0.1:5180** for a Cloudflare tunnel to point at.

**The box has no Node and does not need one.** The Mac builds; Windows serves
four static files with `tools/serve.py`, stdlib only. Cloning the repo there
would not help — it would deliver TypeScript that nothing on that machine can
compile.

Not `vite preview` either, for two reasons: it needs Node, and it gates on the
Host header, which is the thing that would break a tunnel. `serve.py` does not.

Two Windows-specific traps, both handled in that file and worth keeping:

- Python takes MIME types from the **Windows registry** and can return
  `text/plain` for `.js`. A module served as text/plain is refused by the
  browser and the page silently never starts. The extension map is explicit.
- `start /b` from an SSH session dies with the session. `start-fpvsim.bat` uses
  PowerShell `Start-Process`, which detaches properly.

And one deploy trap: `scp -r` **nests** a directory when the destination exists
and **unpacks** it when it does not, so leaving the previous run's staging
directory behind changes the layout of the next deploy. That is how a stray
`C:\Users\gilbo\fpvsim\fpvsim` appeared. The script now clears staging first.

Verified end to end by tunnelling `ssh -L 5181:127.0.0.1:5180` and running
`node tools/browser-check.mjs http://127.0.0.1:5181/` against the live
instance: isolated, atomics ticker, scene drawing, no page errors.

Now binds **0.0.0.0** so the LAN can reach it, with a firewall rule
`fpvsim 5180`. But a LAN address is not a trustworthy origin: gamepads are inert
and COOP/COEP are *ignored regardless of what the server sends*, so it is for
looking at, not flying. The page's warning blames the origin rather than the
host for exactly that reason. `localhost` is trustworthy, so
`ssh -L 5180:127.0.0.1:5180` gives a fully working page where the LAN address
does not.

The server process runs as **python3.13**, not `python.exe` — `tasklist` and
`Get-Process python` both miss it. Find it via
`Get-NetTCPConnection -LocalPort 5180`.

**Per-pilot state** lives in three localStorage keys: `fpvsim.mappings.v1`
(per device id), `fpvsim.tune.v1`, and `fpvsim.scene.v1` (FOV, camera tilt, map,
reset mode). The last of those was added 2026-08-29 — camera tilt and FOV were
being reset on every reload, which is exactly the kind of friction that gets a
tool abandoned rather than reported. Note that localStorage is **per origin**,
so a pilot who sets up on the LAN address and then moves to the Cloudflare one
starts over.

**Measured load**, 30 s with a headless client flying: server 0.016 CPU-seconds
(0.05% of one core) and 25.7 MB; client 1.8% of a core in script, 6.1% across
all tasks, 2.6 MB heap. The server does nothing per visitor beyond handing over
80 KB once.

**Known limitation:** it is a bare background process, so it does not survive a
reboot. A Scheduled Task or the Docker path would fix that when it matters.

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
