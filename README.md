# fpvsim

Browser-based FPV drone simulator for skill training, flown with a real RC
transmitter over USB. See the project brief for the full scope; first target is
a single 5" racing quad and a few simple maps with basic track obstacles.

**Current phase: M2 — the scene.** M0 (input spike) is signed off: the tick
source holds 1 kHz on real hardware and the radio was measured at 201.8 Hz. M1
adds the flight model itself — blade-element rotors, brushless motors, battery
sag, and a Betaflight-scaled PID loop, stepping at 1 kHz inside the input tick.
Still no 3D scene, deliberately: per the brief the feel has to be right before
any art exists, and the instrument panel is how you judge it in the meantime.

## Run it

```
npm install
npm run dev            # http://localhost:5180
npm run build          # typecheck + production build

npm run check:flight   # physical acceptance tests for the model, headless
npm run check:browser  # drives the real page over CDP (needs `npm run dev`)
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
| Chrome 147, focused window, 60 s, TX16S attached | atomics | 1000.0 Hz | 0.062 ms | 1.175 ms | 1.255 ms | 3.91 ms | 0 (60,112 ticks) |
| **same, repeat run 10 h later** | atomics | 1000.0 Hz | **0.038 ms** | **1.110 ms** | 1.245 ms | 3.55 ms | 0 (60,065 ticks) |

Raw results for both runs are in `measurements/`.

The real run is *better* than the headless floor on every tick statistic — sd
0.062 vs 0.080 ms, p99 1.175 vs 1.340 ms, max 3.91 vs 7.44 ms. Headless Chrome
has no compositor to schedule against but also no display to pace to; the
windowed run gets a steady 60 Hz vsync and a warm scheduler. Tick lateness:
mean 0.209 ms, p99 0.255 ms, max 3.14 ms. 23 intervals exceeded 2 ms, none
exceeded 8 ms, and 57,823 of 60,112 landed in the 0.9–1.1 ms bucket.

**The tick source is not the problem.** 1 kHz on the main thread is real.

### The radio reports at 200 Hz, not 1 kHz

This is what M0 was built to find out, and it is the number that shapes M1.
Two independent 60 s runs, ten hours apart:

| | run 1 | run 2 |
|---|---|---|
| device | Radiomaster TX16S (`1209:4f54`), 8 axes | same |
| report rate | 201.8 Hz | 200.4 Hz |
| mean / p50 | 4.96 / 4.99 ms | 4.99 / 5.00 ms |
| p90 | 5.99 ms | 6.00 ms |
| p99 | 9.13 ms | 10.00 ms |
| p99.9 | 20.0 ms | 15.0 ms |
| max | **135.0 ms** | **34.0 ms** |
| fresh samples | 12,131 | 12,036 |

So roughly **one poll in five sees new data**. Polling at 1 kHz is still the
right thing to do — it costs nothing, it keeps the physics step on a fixed
clock, and it means the sim reacts within 1 ms of a report arriving rather than
waiting for the next frame — but the stick signal itself is a zero-order hold
that only changes every ~5 ms.

Note that p50 5 ms and p90 6 ms are partly an artefact of measuring a 200 Hz
signal on a 1 kHz polling grid: the observation quantises to whole
milliseconds. The mean, 4.99 ms, is the honest figure for the period.

Three consequences for M1:

1. **~2.5 ms of mean quantisation latency is already spent** before the flight
   model does anything, and up to 5 ms worst case. That is a floor on
   stick-to-state response no amount of physics work can recover.
2. **Reports are dropped at a steady ~2 per second.** p99 sits at almost exactly
   two report periods in both runs, which means the worst 1% of gaps each
   swallowed a report: 121 and 120 occurrences in 60 s respectively. This is the
   most reproducible thing in either dataset and it is not an outlier — it is
   how the link behaves.
3. **The extreme tail varies and does not repeat.** The 135 ms gap in run 1 —
   about 27 consecutive missed reports — did not recur; run 2's worst was 34 ms.
   So a gap of tens of milliseconds should be expected roughly once a minute,
   with a worst case that is not predictable from a single run.

M1 therefore holds the last stick value and keeps integrating, never assuming a
fresh sample per step, and the flight panel disarms on link loss. Both of those
are consequences of this table rather than of good intentions.

What causes the drops — radio, USB stack, or macOS HID scheduling — is still
unknown. Two runs establish the rate but not the mechanism, and nothing in the
browser can see far enough down to tell.

Reference: `requestAnimationFrame` held 60.0 Hz (sd 0.38 ms) throughout, so
rendering was not stealing from the input path.

That covers loop pacing only. It is **not** end-to-end input→photon latency,
which per the brief still needs a photodiode or high-speed-camera rig.

## M1 — the flight model

Everything under `src/flight/` is plain TypeScript with no browser dependency,
so it runs under `node --experimental-strip-types` with no build step. That is
what makes `npm run check:flight` possible, and it is worth the one constraint
it imposes: no parameter properties, no enums, no namespaces anywhere in that
directory, because strip-only mode cannot compile them.

| file | what it is |
|---|---|
| `math.ts` | vectors, quaternions, exponential-map integration |
| `filter.ts` | PT1 and biquad, the filters a flight controller actually runs |
| `rates.ts` | Betaflight Actual and Betaflight rate curves, ported not approximated |
| `pid.ts` | the rate controller, in Betaflight's own gain units |
| `mixer.ts` | quad X mix derived from geometry, with airmode |
| `motor.ts` | brushless motor as an electrical model, plus battery sag |
| `rotor.ts` | blade-element rotor with momentum-theory inflow |
| `airframe.ts` | mass, inertia, geometry — the 5" 6S racer |
| `sim.ts` | the 6-DOF body that ties it together |

### Pitch convention

**Positive pitch is nose-down**, throughout the control path: stick, setpoint,
gyro, mixer. That is Betaflight's convention and every FPV pilot's, so forward
stick drops the nose and flies you forward, and a Blackbox log needs no sign
correction to be compared against.

The rigid body underneath keeps the standard FRD frame, where positive about +y
is nose-up, because the cross products and quaternion integration depend on it.
`sim.ts` converts once, where the gyro enters the controller. `attitude.pitch`
is also nose-up positive, since that is what an artificial horizon means by it.

The model shipped with the aviation convention first and every pilot who flew it
had to invert pitch by hand. Two things follow from that. The convention is the
domain's to choose, not the physics'. And the sign tests that all passed
throughout were comparing achieved rate against setpoint, which is blind to a
whole-model flip — the tests that matter fly the quad from a raw stick axis and
check which way it goes.

### Frames

Body is FRD (x forward, y right, z down), world is NED. Gravity is +z. This is
the aerospace convention rather than the graphics one, chosen so gyro and PID
signs match Betaflight directly and a real tune transfers without translation.
The renderer will convert to Y-up at its own boundary; the physics never does.

### Why blade-element

A thrust constant would fly, but it cannot produce the moments a pilot trains
against: thrust falling away in a fast descent, translational lift as the quad
accelerates out of its own downwash, or the drag the discs contribute at speed.
Each of those is asserted by a test rather than claimed here.

The same argument drives the motor model. It is electrical, not a first-order
lag on thrust, because the lag is not symmetric — an ESC can apply full pack
voltage to spin up, but nothing brakes a coasting prop on the way down. The
measured asymmetry in this model is 154 ms up against 2640 ms down, and that
difference is most of why a quad drops when you chop throttle.

### Numbers it produces

| | value |
|---|---|
| static thrust-to-weight | 12.2:1 at full throttle |
| hover throttle | 15.8% |
| hover / full-throttle RPM | 8 730 / 30 280 |
| hover / full-throttle current | 14.8 A / 177 A |
| roll step, rise to 90% | 32 ms, 6.8% overshoot |
| step cost | 3.5 us, or 0.35% of the 1 ms tick |

Hover throttle really is that low; a 6S racer at 12:1 hovers around 15% stick,
and a pilot coming off a 4S freestyle build finds it alarming. Reproducing that
rather than smoothing it out is the point.

### Exporting a flight

Section 5 of the page has a recorder: pick a duration and a rate, press
**Record flight**, fly, and it writes out **Download CSV** and **Download
JSON** when it finishes. It samples inside the 1 kHz tick, so 1 kHz means every
step; the export itself happens off the tick, because touching layout from in
there would show up as a stall in the very measurement M0 established.

The field names mirror Betaflight's Blackbox — `gyroADC[0..2]`, `setpoint[]`,
`motor[]`, `axisP/I/D/F[]`, `vbat`, `amperage` — so a sim flight and a real log
can be laid side by side. The extras are things only a simulator can know
(per-rotor thrust, world velocity, altitude, specific force) and are what make
a disagreement diagnosable rather than merely visible.

Units are the model's own, declared in the JSON metadata rather than left to be
guessed: deg/s, newtons, metres, volts, amps. Blackbox's raw units get
converted when a real log is read, so the native side of the comparison never
has to be un-mangled.

### Verification

`npm run check:flight` runs 39 physical acceptance tests — thrust scaling with
rotor speed, hover trim, per-axis control signs, rate tracking and overshoot,
airmode's effect on the mixer, motor asymmetry, battery sag, determinism, and a
20-second full-deflection abuse run. They assert things that must be true of a
5" quad, not things that must be true of this code, which is the only kind of
check that catches a mixer sign error or a rotor making thrust out of nothing.

`npm run check:browser` then drives the real page over CDP and reads state back
out of it: cross-origin isolation, the atomics ticker, physics advancing at
1 kHz inside the tick, arming, climbing, roll tracking, and failsafe.

Three findings came out of writing those tests rather than out of reading the
code: the effective motor resistance was low enough to draw 290 A at full
throttle, the roll inertia was below every published figure for this class, and
there was no gyro clipping at all — the model had perfect knowledge of its own
rotation in exactly the tumble where a real quad has none.

### What the first recorded flight found

A 20 s flight flown on the real TX16S is archived in `measurements/`. It caught
two things 39 acceptance tests did not, which is roughly the point of recording
flights:

- **92 A per motor on a transient.** Full throttle applied to a slow-turning
  motor meets almost no back-EMF, and nothing in the model said no. Real ESCs
  limit current, so `MotorSpec.maxCurrent` now does too — 55 A, which binds only
  on transients since steady full throttle settles near 44 A.
- **Airborne overshoot of ~17% on full-stick flicks**, with 23% of commanded
  samples exceeding setpoint by more than 50 deg/s. The step-response test
  measures 6.8% because it uses a 234 deg/s step; at 800 deg/s the mixer
  saturates and the character changes. Whether a real quad on a stock tune
  overshoots this much is exactly what the Blackbox comparison is for.

Two things it did *not* find, having looked: the 67% of samples with a motor at
zero output is airmode working as designed at low throttle, not clipping. And
the single worst number in the log — 1233 deg/s of pitch against a 792 setpoint
— happened at 0.1 m altitude and is the ground model, not the flight model.

### Comparing against a real log

```
npm run replay -- <log> [--mode windows|full|rates] [--window 0.25] [--out report.html]
```

Reads a Betaflight `.BBL` **directly** — no `blackbox_decode`, no GUI export —
or one of our own recordings, or a decoded CSV. `--session <n>` picks the flight
in a multi-session file. The binary path is preferred: the header travels with
it, so motor range, vbat scale and motor poles are read rather than guessed, and
the quad's own PIDs and rates come along and are used to run the model.

Two things the decoder learned the hard way, both commented at the fix sites:
after an I frame *both* history slots must hold it, or the first straight-line
prediction is nonsense and every frame after it byte-scans looking for sync;
and `TAG8_4S16`'s 16-bit values are big-endian while everything else in the
format is little-endian.

**Whole-flight replay cannot validate anything, and that is measured rather
than assumed.** Replaying this model's own recording reproduces it exactly
while disarmed and then diverges within ten milliseconds of arming. It is not a
harness bug: feeding the same flight stick values quantised to one part in ten
thousand — finer than any radio resolves — moves the roll rate by 1 deg/s
within 33 ms and by hundreds within seconds. An aggressively flown quad is
chaotic, and mixer saturation makes it worse by being a real discontinuity
rather than a steep curve.

So the default mode is `windows`: cut the flight into short segments, seed each
from the state the log records at that instant, replay a few hundred
milliseconds, and aggregate. Seeding runs in from 50 ms earlier with body rates
and rotor speeds pinned to the log, so every filter the controller owns charges
on real history — a single-sample seed leaves the D-term filter at zero and is
already 13% out on motor output at the first step.

**The floor is a property of the flight, not the method.** It has to be measured
per log, and `replay` does that: every window is flown twice, the second time
with the sticks nudged by one quantum of the log's own resolution, and the two
model runs are compared to each other. Skipping this step is actively
misleading — measured against a floor borrowed from an aggressive sim flight,
five of six real logs looked *better than a perfect model*, which is nonsense.
On the real flights, which are gentler, the true floor is 0.0–0.8 deg/s and the
measured errors are 20x to 600x it.

The practical consequence is the one already in the manoeuvre advice above:
gentle, separated, deliberate inputs are what make a log worth fitting. Hard
freestyle raises the floor until nothing can be seen through it.

Against our own aggressive 20 s recording, the floor the method reaches is:

| into the window | 10 ms | 25 ms | 50 ms | 100 ms | 200 ms |
|---|---|---|---|---|---|
| roll | 3.4 | 9.6 | 12.3 | 23.4 | 19.8 |
| pitch | 2.4 | 8.3 | 7.1 | 13.5 | 18.6 |
| yaw | 0.3 | 0.9 | 2.8 | 6.7 | 7.4 |

(median |error|, deg/s, ground-contact windows excluded — the reference's
ground model multiplies body rates by 0.6 every step and the replay cannot
reproduce that from altitude, nor should it try.)

That table is the noise floor. On a real log, anything close to it means
agreement and anything well above it is a modelling difference. **The useful
horizon is 25–50 ms**; past 100 ms the floor is 20 deg/s and climbing.

`--scale-inertia` and `--scale-mass` deliberately break the model to ask how
wrong a parameter must be before the comparison notices. Doubling roll inertia
roughly triples the 200 ms error and multiplies the yaw error by four, so the
method resolves gross errors confidently and a 10% one not at all. Yaw
discriminates best, being the axis least disturbed by saturation.

### Reading a real Blackbox log

`npm run replay -- <log>.BBL --session <n>` reads the binary directly. There is
also `npm run identify -- <log>.BBL --session <n>`, which measures airframe
parameters from the flight instead of taking them on trust.

**Betaflight logs pitch positive nose-down.** This model uses nose-up
throughout, so the reader negates pitch on the way in. Betaflight's own QUADX
mixer gives the *rear* motors a pitch coefficient of +1, which is the giveaway,
but it was established from the data rather than the source — and the way it was
established matters, because the obvious test gives the wrong answer.
Correlating the motor *command* differential against pitch acceleration says
front-up produces nose-up. Correlating the eRPM-derived *thrust* differential
says the opposite, at r = -0.50, at zero lag, on the same flight where roll
gives +0.49. The command has a PID in the loop and is not a witness to
causation; rotor speed to thrust to torque has nothing in it but physics.
Applying the flip dropped pitch error 20-32% and left roll and yaw untouched,
which is what a real sign fix looks like.

### What the logs measured

Given the all-up mass, a log with bidirectional DShot pins down two things no
datasheet will:

| | measured | previously assumed | |
|---|---|---|---|
| rotor thrust coefficient | 1.148e-6 N/(rad/s)² | 1.64e-6 | model was 43% high |
| roll inertia | 1.759e-3 kg·m² | 1.8e-3 | 2% |
| pitch inertia | 8.4e-4 kg·m² | 2.0e-3 | 139% |
| hover rotor speed | 9 568 rpm | — | matches the log's throttle/RPM curve |

The thrust result is the interesting one: the blade-element model's error was a
flat **14% across 6 000 to 26 000 rpm**, so it had the omega-squared law right
and only the aerodynamic scale wrong. A lift-curve slope of 5.7/rad is
thin-aerofoil theory, which a prop section at Reynolds ~40 000 does not achieve.
Calibrating to 3.7/rad with cd0 0.035 closes it.

The pitch inertia fitting at half of roll is not what a symmetric X frame should
give. It uses half as many samples and much smaller thrust differentials, so it
is the weaker of the two fits and is flagged as such in `airframe.ts`.

### What the comparison cannot yet see

Swapping the generic 5" racer for the measured Kronos airframe **barely moves
the result** — better on one session, worse on another. That is consistent with
the sensitivity analysis: windowed replay seeds rotor speeds and the I-term from
the log, and over 250 ms a rate-mode PID compensates for a good deal of airframe
error. So the residual 20 / 13 / 7 deg/s is not mostly airframe parameters.

The likelier candidates are all things this model does not have: `d_min` is
active on the real quad (21/30/0 against d_max 37), so is anti-gravity (gain
80), the gyro runs a dynamic lowpass rather than the static one modelled here,
and RC smoothing shapes the setpoint before the PID sees it. Each is a
concrete next step with a measurable outcome, which is a better position than
the model was in yesterday.

### Working the residual down

The comparison said the model was **too soft and too late** — gain 0.44-0.86,
lag 6-18 ms, consistently on every axis of every flight. That decomposition is
worth more than the RMS it came from: "wrong by 20 deg/s" points nowhere, while
"responds at 60% amplitude, 13 ms late" points at a short list.

Working down that list, in order, measuring after each:

| change | effect |
|---|---|
| filter cutoffs read properly from the header | ~1% — ruled out |
| driving from the logged setpoint instead of the sticks | 2-12% |
| **feedforward: 100x scaling bug** | large |
| RC smoothing on the setpoint | required for the above to be right |
| D_MIN | gain 0.79 → 0.81, pitch lag 4 → 2 ms |
| **motor time constant, measured** | large |
| **pack current vs motor current** | large |

Net: roll error down 20-28%, yaw down 27-29%, and lag essentially eliminated on
roll and pitch (18 → 6 ms, 13 → 1 ms).

Three of those were real defects in the model rather than missing features:

- **Feedforward was 100x too strong.** Betaflight computes
  `Kf = FEEDFORWARD_SCALE * (F / 100)` where P, I and D use their configured
  value directly. This hid behind the pidSum clamp in synthetic tests — the term
  saturated and the step response still looked plausible — and only became
  visible against a real aircraft.
- **The motor was four times too slow.** Its mechanical time constant is
  `J*R/ke^2`; an estimated 0.16 ohm and 6.5e-6 kg·m² gave 49 ms where the logs
  measure **11.5 ms** from ESC command steps against eRPM.
- **The battery was charged motor current instead of pack current.** An ESC is a
  switching converter: the pack supplies `duty x motor current`. At part
  throttle that overstated the draw several-fold — and an inflated winding
  resistance had been quietly compensating for it, which is what made the motor
  four times too slow in the first place. One error had been hiding the other.

### M1 sign-off

Signed off 2026-08-26, against NACRONOS: Kronos Legacy, 470 g all-up on 6S,
Gemfan 51377, 2107 at 2080 KV, 205 mm motor-to-motor.

Four independent quantities measured from the flight, reproduced by the model
with **one fitted aerodynamic constant** between them:

| | aircraft | model |
|---|---|---|
| hover rotor speed | 9 568 rpm | 9 428 |
| hover pack current | 6.4 A | 6.2 |
| full-throttle rotor speed | 28 286 rpm | 28 046 |
| peak pack current | 278 A | 280 |

Rate response against three real flights, windowed:

| | roll | pitch | yaw |
|---|---|---|---|
| RMS error, deg/s | 13.9-21.0 | 8.8-11.7 | 3.9-8.2 |
| gain | 0.74-0.86 | 0.44-0.54 | 0.62-0.86 |
| lag, ms | 1-5 | 0-3 | 3-11 |

Over the course of this work the roll error fell 39% and the lag went from 18 ms
to under 5. **Timing is right; amplitude is not.**

### What is still wrong

**The model responds too softly.** Gain 0.74-0.86 in roll, 0.62-0.86 in yaw, and
**0.44-0.54 in pitch**. A pilot would feel that: the model needs more stick than
the aircraft for the same rotation.

Pitch is the outlier and it is unexplained. Its measured inertia is less than
half of roll's, which a symmetric X frame should not give, and a stretched frame
would have explained both — but the frame is 205 mm square, so it does not. The
inertia anomaly and the gain anomaly are probably the same unknown.

**Propeller drag and motor loss are not separable from this data.** The logs
constrain their sum and nothing else, so `profileLoss` at 2.4 carries both and
the model is right about the system while being unreliable about which component
the loss belongs to. A thrust-stand run on the prop, or motor efficiency data,
would split them.

Anti-gravity is still unimplemented, and yaw keeps a few ms of lag that roll and
pitch have lost.

Gain is still 0.48-0.83: the model responds at roughly half to four-fifths of
the aircraft's amplitude, worst in pitch. The prop's **torque coefficient is
~1.7x low** against the same logs (3.0e-8 measured, duty-corrected, against
1.45e-8 modelled), which also puts hover current at the bottom of the measured
range and lets the model overspeed at full throttle — 38 000 rpm against a
logged 28 300.

Matching it by raising `cd0` alone would need 0.19, four times any real
aerofoil, so that would be curve-fitting rather than modelling. Some of the
measured torque is motor and ESC loss being misattributed to the prop. Left
open deliberately.

Anti-gravity is also still unimplemented, and yaw retains 9-18 ms of lag that
roll and pitch no longer have.

## M2 — the scene

Section 5 of the page is an FPV view: WebGL2, one shader, two draw calls, three
maps. It renders every animation frame while the text panels stay at 30 Hz,
because rebuilding their DOM at display rate costs more than the scene does.

Written directly rather than on a scene-graph library. The geometry the brief
asks for is a ground plane, gates and pylons; the project has no runtime
dependencies and this keeps it that way; and a renderer written here can be
instrumented for frame cost like everything else.

**Frames convert once, at the renderer's boundary.** The physics stays FRD body
in NED world — that is where the gyro and PID signs come from and it is not
negotiable — and the renderer maps it to Y-up:

```
render.x =  east  =  ned.y
render.y = -down  = -ned.z
render.z = -north = -ned.x
```

which is right-handed, so nothing comes out mirrored.

### Three things the scene got wrong, and how they were caught

None of these threw an exception, and a check that only watches for errors would
have passed all three.

- **The camera basis was not orthonormal.** Rotating body-up about the tilt axis
  gives `(-sin t, 0, -cos t)`; using `+sin t` left forward·up at 0.766 instead of
  0. A skewed basis still draws a picture, just a sheared one — the horizon sat
  in the wrong place and vertical posts leaned. There is now a test asserting
  orthonormality across tilt, roll and pitch, because this is a maths error that
  looks like an art problem.
- **Seven gates in a straight line at one height nest perfectly behind each
  other.** The geometry was right and the scene was useless: the pilot saw one
  gate. They are staggered now, which is also a better exercise.
- **The ground chequer was invisible**, its two greens differing by 0.03. At
  20 m/s over an untextured plane a quad looks stationary, which defeats the
  point of having a scene.

The browser check reads pixels back off the canvas and asserts the frame is not
a flat fill, because "no exception thrown" would have passed with WebGL absent
entirely — `SceneView` degrades gracefully on purpose. Headless Chrome needs
`--use-angle=swiftshader --enable-unsafe-swiftshader` or there is no WebGL2 to
test.

### What the scene is not

The lens is rectilinear. Real FPV cameras are far wider and strongly barrel
distorted, and a rectilinear projection at 150° stretches the edges into
something no camera produces — so the default is 75° vertical (about 120°
horizontal) which at least does not lie about the middle of the frame. Matching
a real lens is a later job.

Collision now exists — see below — so the quad hits what it can see.

### A pilot report, and what it found

> "Pitch and roll feel a little like it's horizon/angle mode — put in a little
> roll or pitch without throttle and let it go, and the quad starts to shake as
> if it tries to stabilise itself back. That is not expected in acro."

It was not angle mode: with the sticks centred the model holds 30° or 60° of
roll indefinitely and rotates at exactly zero. But the report was right about
everything else, and the recorded flight showed why — a damped oscillation with
the sticks centred, ringing for 400-600 ms, **every instance at zero throttle**.

Settling time after releasing a roll input, before and after:

| throttle | 0% | 5% | 10% | 16% | 40% |
|---|---|---|---|---|---|
| before | never settles | 409 ms | 192 ms | 80 ms | 23 ms |
| after | **81 ms** | 80 ms | 18 ms | 18 ms | 14 ms |

**The cause was that the simulator was flying the uncalibrated airframe.** Every
parameter measured from the Blackbox logs — rotor thrust, motor time constant,
inertia — went into `kronos()`, while `FlightPanel` constructed a bare
`FlightSim()` and got `racer5()`, whose motor was four times too slow and whose
prop was 43% out on thrust. Low throttle is exactly where a slow motor hurts
most, because it is where the demanded rotor-speed change is largest.

Two smaller things came out of the same investigation: `defaultMotor()` still
carried the inflated 0.13 ohm resistance that had been standing in for the
pack-current bug, and Betaflight's `iterm_windup` anti-windup was not
implemented at all. The anti-windup turned out not to be the cause here — the
mix range never approaches the windup point at low throttle — but it is real
behaviour and it is in now.

The lesson is not about motors. It is that **a calibration is worthless if the
thing being calibrated is not the thing being flown**, and no test caught it
because every test constructed its own airframe explicitly. A pilot flying it
for ten minutes caught it immediately.

## Rates and tune

Section 6 is where a pilot's own rates go, and it exists because one asked where
he was supposed to enter them and the answer was that he could not. The model
had been flying its own defaults — **800 deg/s at full stick against his quad's
512** — while feeling nearly right around centre (228 against 221 deg/s), which
is precisely why it took a pilot rather than a test to notice. The rate curve is
most of what makes muscle memory transfer, so it has to be the right curve.

Three curves — Actual, Betaflight and KISS — editable per axis **in the units a
configurator shows**, with the centre sensitivity, full-stick rate and the
stick-to-rate shape live, and the tune saved in the browser. The field names
change with the curve, because they are not the same fields: Actual has centre
sensitivity and max rate in deg/s, Betaflight has RC rate and super rate,
KISS has RC rate, rate and RC curve.

That distinction was a bug worth recording. The panel first showed Betaflight's
internal storage values, so a quad reading `1.05 / 0.59 / 0.01` in its
configurator appeared here as `105 / 59 / 1` — anyone typing what was on their
screen would have been out by a hundred.

And **KISS is not Betaflight's curve**, which an earlier version of this claimed.
They agree only when expo is near zero, which happened to be true of the quad it
was checked against. With an expo of 40 they are 8% apart at half stick: 96.8
against 104.3 deg/s. Both are implemented properly now, and there is a test that
they differ with real expo and coincide without it.

**The important button is "Load from Blackbox log".** Every one of these values
already exists in the header of any `.BBL`, so the reliable way to fly your own
quad is to hand over a log rather than retype a dozen numbers out of a
configurator — and it brings the PIDs, filters, feedforward and D_MIN across
too. Reading the header of a 16.8 MB log takes 11 ms, because it parses only the
text at the front and never touches the frame stream.

`FlightSim.applyTune()` swaps a tune while flying: the rate profile is mutated
in place so references stay valid, and the controller is rebuilt because its
filters are constructed from the cutoffs and cannot be re-cut.

## Collision

`src/flight/collision.ts`. Four contact points, one under each arm, each pushed
out of any surface it is inside by a spring-damper along the normal with Coulomb
friction across it. Obstacles are cylinders and boxes in NED; the track emits
them from the same call that builds the mesh, so a gate cannot be drawn in one
place and be solid in another.

It replaces a hard floor that clamped the centre of gravity and multiplied body
rates by 0.6 every step. That was honest as a placeholder and useless as
physics: a quad hit the ground at 27 m/s in a recorded flight and simply carried
on, and half that flight was spent within half a metre of a surface it could not
touch.

Penalty contact is worth the arithmetic because resting, sliding, tipping,
bouncing and tumbling all fall out of the same four lines. Nothing is a special
case, and set down at 45° the quad falls flat — which a position clamp cannot do
at all.

A hard enough impact sets `crashed`, disarms, and keeps simulating, because a
crashed quad still tumbles. Scenery is less forgiving than grass by a factor of
three: a post takes a prop off at a speed the ground would shrug at.

**Recovering is one key: `R`.** By default it puts the quad back *where it went
in* — level, stationary, standing on the ground, pushed clear of whatever it
hit, facing the way it was going before it tumbled — intact and already armed,
provided the throttle is down.

On the ground, not hovering, and that distinction shipped as a bug first.
Handing the quad back in mid-air looks friendlier and is a trap: the throttle
has to be down for it to re-arm, so a metre and a half of free fall arrives at
5.2 m/s, over the 4.5 m/s crash threshold, and it crashes again within 600 ms.
The pilot presses reset, watches it drop, and cannot fly. There is now a test
that a respawn left alone at idle is still intact three seconds later, which is
the check that was missing. Sending a pilot to the start line after every
crash spends their session on the walk rather than on the thing they were
practising. The scene has a selector for the other behaviour, and "To start
line" is always one click away. Crashing is the normal
outcome of practice and making a pilot re-arm after every one is friction with
nothing behind it — arming is a deliberate act once per session, not once per
prang. If the throttle is up it stays disarmed and says so, because otherwise
the quad would leap off the reset.

Arming a crashed quad is refused. That is not a flight-controller behaviour, it
is an honesty one: without it a wreck could be re-armed where it lay, flag still
set and banner still up, and fly on as though nothing had happened.

A quad that crashes while already disarmed — dropped from a height — comes back
disarmed, because it was not flying.

The tests are behaviours rather than numbers — it rests without sinking or
buzzing, falls flat from 45°, survives a gentle landing, crashes and disarms
from 30 m, stops at a pylon's face, passes cleanly beside one, flies under a
gate bar and crashes into it.

### A failsafe that was not one

Chasing the reset behaviour turned up something worse. When the poller has no
device it returns early and leaves its axis array untouched, and **a raw zero on
a unipolar channel is mid-travel, not the bottom** — so a vanished radio
presented as 50% throttle rather than none. The failsafe disarmed, so nothing
ever flew away on it, but every consumer downstream was being told the pilot was
holding half throttle. No link now means no input, explicitly.

### The maps

**Circuit** is the default: eleven gates round a loop, plus freestyle furniture
to have opinions about — floodlight masts, two tubes to thread, and three square
windows, one low enough to take on the straight and two up high. **Gate run** is
a staggered line for practising a single trajectory, and **Open field** is
somewhere to learn hovering with nothing to hit.

Every obstacle emits its collision volume from the same call that builds its
mesh, so the circuit's 76 volumes cannot drift from what is drawn.

### Known gaps, stated rather than omitted

- **Not validated against a real Blackbox log.** The model is physically
  principled and internally consistent, but nobody has yet put a log from a real
  5" quad beside it. That comparison is the M1 sign-off, and it is the same
  shape of gap the published jitter number was in M0.
- No azimuthal integration in the rotor, so no blade flapping and no roll-off in
  fast forward flight. In-plane flow is a Glauert factor and an H-force.
- Vortex ring state is not modelled; the model is optimistic in a steep powered
  descent.
- No anti-gravity, dynamic idle, or D_MIN. Each is a real part of modern feel.
- No rotor-to-rotor interaction, so no prop wash.
- Contact is four points under the arms, not a mesh: the airframe between them
  passes through thin scenery, and there is no damage model beyond a crash flag.
- Rate mode only. No angle or horizon mode, which is what the brief is about.
- Under 20 s of sustained full-deflection stick reversal the model tumbles past
  4 000 deg/s. The gyro clips at 2 000 deg/s exactly as real hardware does, and
  it recovers when the sticks centre, but the peak is higher than a real quad
  reaches and is worth revisiting once there is a log to compare against.

## What a visiting pilot sees

Five sections, in the order they need them: pick the radio, map the channels,
fly, load a tune, read the instruments. The development instrumentation — raw
axis values and the M0 jitter test — is folded into a collapsed
**Diagnostics** block at the bottom. It still works and is still how the input
path was measured; it is simply not what someone who has been sent a link is
there for.

The dev-only debug handle (`__fpvsim`) is absent from a production bundle —
`import.meta.env.DEV` compiles it out, verified by grepping the built asset —
so the browser check's deep assertions degrade to a smoke test against a real
deployment. That is deliberate: a shipped page should not carry a load-bearing
API into the world.

## Hosting it for someone else

**Everything runs on the pilot's machine.** There is no `fetch`, no
`XMLHttpRequest`, no WebSocket and no beacon anywhere in the source; the only
non-relative reference in the built page is a `data:` URI favicon. Physics,
rendering, gamepad polling, log parsing and recording all happen in their
browser, persistence is `localStorage`, and nothing is uploaded. The host serves
four files, about 80 KB, once per visitor and then does nothing — three pilots
or three hundred is the same load.

Two things the host must get right, both of which fail quietly:

### HTTPS, or the page is for looking at, not flying

On an origin the browser does not trust — plain `http://` to anything but
localhost — two things switch off at once. Gamepads are hidden or inert, and
**COOP/COEP are ignored no matter what the host sends**, so cross-origin
isolation is lost and the ticker falls back. Chrome says as much in the console:
*"the Cross-Origin-Opener-Policy header has been ignored, because the URL's
origin was untrustworthy"*.

That distinction matters when reading the page's own warning. It blames the
origin rather than the host, because "your server is not sending the headers"
would send someone to fix a thing that is not broken.

`localhost` counts as trustworthy, so an SSH tunnel to the serving machine works
fully where its LAN address does not.

### COOP/COEP, or the 1 kHz ticker degrades

Without `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` the worker cannot allocate a
`SharedArrayBuffer`, so the ticker falls back to `setTimeout(0)`. It still
flies — the flight model is untouched — but loop pacing is worse, and the page
shows a banner saying so. `public/_headers` covers Netlify and Cloudflare Pages.
**GitHub Pages cannot set response headers at all**, so it cannot host this
without that fallback, which is worth knowing since the repo already lives
there.

### From the Windows desktop

`SSHPASS=… ./deploy-windows.sh` builds here, ships `dist/` plus a stdlib Python
server, and restarts it on **127.0.0.1:5180**. The box needs no Node: the Mac
builds, Windows hands over four static files, and every byte of computation
happens in the visitor's browser. `tools/serve.py` sets COOP/COEP itself and,
unlike `vite preview`, does not gate on the Host header — so a tunnel needs no
allow-list.

### From your own machine, through a tunnel

```
npm run build
npm run preview                       # serves dist on :4173 with the headers
cloudflared tunnel --url http://localhost:4173
```

`vite preview` already sends COOP/COEP, and the tunnel supplies HTTPS, so this
keeps full timing fidelity with nothing to configure.

One catch, and it fails on the very first request: Vite answers only to
`localhost` and bare IPs unless told otherwise, and skips that check only over
HTTPS. A tunnel arrives over plain HTTP carrying the *public* hostname, so
without `preview.allowedHosts` every request returns
`403 Blocked request`. `vite.config.ts` allows `.trycloudflare.com`; set
`FPVSIM_ALLOWED_HOSTS` for a domain of your own. It is deliberately not `true`,
which Vite's own docs flag as inviting DNS rebinding onto whatever network the
machine is sitting on.

### What each pilot's browser remembers

Everything a pilot sets is kept in their own browser, under three keys:

| key | holds |
|---|---|
| `fpvsim.mappings.v1` | channel mapping and calibration, **per device id** |
| `fpvsim.tune.v1` | rate curve, PIDs, filters |
| `fpvsim.scene.v1` | FOV, camera tilt, map, reset mode |

Nothing is sent anywhere, and nothing is shared between pilots — the host has no
idea any of it exists.

**`localStorage` is per origin**, which is the part that catches people out. A
pilot who maps their radio at `http://192.168.7.54:5180` and then opens the
Cloudflare address is a different origin and starts from scratch. For a feedback
round, give everyone the final URL first and let them set up once.

### What it costs to run

Measured against the deployed instance, with a headless browser flying it for
30 s:

| | |
|---|---|
| **server** CPU | 0.016 s over 30 s — **0.05% of one core** |
| **server** memory | 25.7 MB, all of it the Python interpreter |
| **client** script | 1.8% of one core |
| **client** all tasks | 6.1% of one core, including compositing |
| **client** JS heap | 2.6 MB |

The asymmetry is the design. The server hands over four files and then does
nothing at all; a second visitor costs it another 80 KB and no more. The client
runs a 1 kHz flight model and a renderer for about 6% of one core.

Serving over plain http to a LAN address costs the client *less* — 5.6% against
6.1% — which is not good news: the ticker has fallen back to a timer there and
is doing less work than it should.

### Checking a deployment

`node tools/browser-check.mjs <url>` works against any of these. Against a dev
server it runs the full suite through a debug handle that only a dev build
carries; against a built artefact that handle is absent on purpose, and it
degrades to a smoke test — isolation, ticker backend, the banner matching the
environment, the scene actually drawing, and no page errors. Cross-origin
isolation is reported as a warning rather than a failure there, because it is a
property of the host rather than of the build.

## Related work on this machine

- `../genius-invester` — Flask + SQLite portfolio portal and a running
  pre-registered experiment. Worth reading for conventions rather than code:
  frozen parameters, append-only ledgers, and pre-committed criteria.
