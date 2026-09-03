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

The recorder lives in **Settings → Diagnostics**: pick a duration and a rate, press
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

Five maps. Four carry a race course; one deliberately does not.

**Race vibes** is what a first-time visitor lands on, since racing is the thing
this is for — six gates, three flags of which two *are* one side of a gate, and
two cubes. Seventeen checkpoints. Everyone else keeps whichever map they last
chose.

The cubes are why a checkpoint is no longer always a frame you fly through
sideways. `Gate.dirU` makes one a **horizontal** plane, so off gate 2 you climb
and **drop into the single cube through its open top**, leaving by the west
face; and off gate 5 you go **into the two-storey cube at ground level, up the
shaft and out of the top**, then across — through the upper storey sideways,
then through the lower one — and only then round the pole standing on gate 5. The crossing test used to
assume a horizontal normal; both in-plane axes now come from one helper that the
marker imports too, so what is drawn and what is timed cannot disagree about
which way "across" points.

**Thrust line** is 20 gates out over 266 m, a pole to turn round, and 20 back on
a parallel line. Acceleration and braking with nothing else to think about. It
is the one place where identical gates in a line are the point rather than the
mistake the old gate run made: the receding frames read as a tunnel, and the
numbered blocks beside them say which is which.

**Circle** is 20 gates evenly round a 60 m circle, so a lap *is* the circle and
there is no straight anywhere on it. Each gate faces along the tangent, which
means a gate taken square is a turn that was right at that instant. There is a
mast at the centre because without one fixed feature it is genuinely hard to
tell a circle from a spiral.

**180s** is two combs of ten gates 12 m apart: through one, hard 180, back
through the next, ten times, then across to the second row and back. Nothing but
turnarounds, which is what actually costs time on a real track.

**Freestyle** carries no course and no timer, which is the point of keeping one
map where nothing is being measured. It also carries a **block of cubes** — a
3x3 grid one, two and three storeys tall, joined side to side so the faces line
up, because the line worth finding is the one that goes through several of them
without coming out. Eleven gates round a loop, plus things to
have opinions about — floodlight masts, tubes to thread, square windows,
**ladders** whose gaps are windows to climb, **chimneys** to dive (18 m of shaft
with the exit out of sight until halfway down), and **arches** to carry speed
through. It was "Circuit" until the race maps arrived.

**Every gate has the same aperture: 3.96 m wide by 3.05 m tall**, race and
freestyle alike, with the frame proportioned around it — two constants,
`GATE_HALF_W` and `GATE_HALF_H`, and the whole gate scales with them. The
uprights are banded yellow and white like the flag poles, and the rails are
tubes of the same radius rather than rectangular beams — equal radii is what
makes the corner disappear, because the post's end cap ends up inside the rail's
surface. A plank meeting a round post had a visible edge; a frame welded from
one gauge of tube does not. The banding is not decoration either: a plain column
gives no sense of distance or closing speed, and bands give both, which is the
same reason the flag poles have always had them.

That is **twice** a MultiGP 5 ft gate in height and 30% wider than that again,
and it is worth naming as a concession rather than quietly relabelling it. It
was the MultiGP figure exactly for about an hour; flying it said otherwise. The
shape is the standard one, the size is a simulator's compromise, and pretending
otherwise would make every lap time here mean more than it should. There are
checks on both numbers, because they are load-bearing for how every course flies
and a silent drift in either would change every lap time.

Wider rather than uniformly bigger, because a gate is missed sideways far more
often than vertically: the line into it is horizontal, and the error that
matters is the one in the turn. Keeping the height where it was keeps altitude
honest.

The next-checkpoint marker traces the aperture rather than carrying its own
idea of a gate's size, so it followed both resizes without being touched — and
there is a check asserting it, since "it happens to be built from the same
numbers" is true right up until someone hard-codes one.

Gates are drawn at their true heading rather than snapped to an axis. That
sounds obvious and was not: the builder took an `'x' | 'z'`, which is harmless
on a course whose gates face north or east and wrong on every gate of the
circle. It showed up as the next-checkpoint marker looking *tilted* relative to
the gate — the marker was right and the gate was wrong. They share one
definition of "across" now, and the check that used to measure distance to the
nearest post (which is half a gate's width at any angle, so it passed happily)
now asks where the posts actually are.

Every obstacle emits its collision volume from the same call that builds its
mesh, so the drawn scene and the solid one cannot drift apart. The arches are
where that shows: they are drawn as quads round the arc, because axis-aligned
boxes would have made a staircase, while contact stays one box per segment —
which is close enough to a quarter-metre of arc and does not need to be pretty.

**Freestyle hard** is the second map with no course, and it is vertical where
Freestyle is a loop: towers of cubes three to six storeys, poles from 4 m to
26 m so that going over one puts you under the next, three **round** chimneys to
drop, five gates high enough that reaching them is half the trick, and three
tall ladders. Three bands rather than a circuit, so a pilot picks a direction
and commits.

The round chimney is why `Ring` grew a third axis. Every tube before it was
something you fly *through* horizontally; a vertical shaft is something you drop
down, and its wall is purely horizontal — you can fall the length of the bore
and only ever hit it sideways. There are checks for exactly that.

Two maps went when the race maps arrived. **Open field** was four pylons and a landing
pad, which is what an empty scene looks like once there is anywhere better to
go, and **Gate run** was a staggered line that the thrust line now does properly
and times.

### Sound

Motor noise is synthesised from the model's own rotor speeds rather than played
from samples. Four oscillators, one per motor, each at that motor's **blade-pass
frequency** — `rpm / 60 x blades`, the tone a prop actually makes — through a
lowpass that opens with load, plus broadband noise for the disc and the
airframe's speed through it. The beating between four motors as the mixer splits
them is most of what a quad sounds like working; a single tone scaled by mean
rpm sounds like a hair dryer. A crash is a bandpassed burst that sweeps down for
the plastic and a short sine for the mass.

Synthesis rather than samples for three reasons: nothing to download, the pitch
is right at every rpm rather than at the three that were recorded, and the page
stays a handful of static files with nothing to fetch at run time.

**Off means off.** Turning it off closes the `AudioContext` and drops the whole
graph, so the cost is one property check per rendered frame and nothing at all
on the audio thread. That was the requirement, not an optimisation: the timing
story is why anyone trusts this simulator, and a feature nobody asked for must
not be able to spend any of it. There is a check that asserts exactly this —
context `closed`, no oscillators, and `update()` still safe to call.

Nothing audio-related runs in the 1 kHz tick. A crash sets a flag there; the
render loop turns it into sound, so no audio node is ever allocated inside the
flight loop. `update()` runs at 30 Hz and every parameter is a smoothed target,
so the ear cannot hear the update rate.

Crossing a checkpoint has its own blip — one for a gate, another for a flag, an
arpeggio for a completed lap — because in a race the pilot is looking at the
next gate, not at the panel, so confirmation that one counted can only arrive in
the ear. The race counts crossings on monotonic counters and the render loop
turns a change into a sound, so the tick stays free of the audio graph.

Getting the pitch right needed the recording. The first version put a gate at
1 568 Hz, straight on top of blade pass at full throttle, where it was
indistinguishable from the motor sweeping past the same note. They sit above the
rotors now, with a slight downward glide: a dead-steady tone reads as part of
the motor noise, a falling one reads as an event.

`node tools/sound-preview.mjs out.wav` records what it sounds like without
flying it: it drives the real graph through a scripted rpm profile in a headless
browser, taps the mix, and writes a WAV. That exists because sound is the one
thing here that cannot be checked by reading a number back — `audio.debug()`
says the oscillator was *asked* for 1 200 Hz, which is equally true of a graph
that is silent, wrongly balanced, or clipping.

### Finishing a race, and why a lap is struck out

A lap is voided by one thing only: a respawn during it. A crash respawns you
automatically so the race stays finishable, which makes it the case a pilot does
not connect to the struck-out row afterwards — so the row says *how many*
respawns rather than merely striking itself through, in the table and on the
video alike.

The result also lands **on the video** for nine seconds after the last gate:
hole shot, each lap, best, best three, total. No splits there — the table
underneath is where a race is studied, and the picture is where one is finished.
In fullscreen the panel does not exist at all, which is the whole reason.

There is a check that flies a clean race through the real page with nothing to
hit and asserts every lap counts, so "all my laps were struck out" can be
answered with something better than a shrug.

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

## Race mode

**A race belongs to a map.** The course is a property of the track — `raceField`
declares `sixGateCourse` and the practice maps declare none — so Start race is
only live on a map whose gates are actually standing there, greyed out with the
reason beside it everywhere else. Switching
away mid-race stops it and clears the marker.

That is not a nicety. It shipped without the binding, and the timer ran its own
course whatever map was loaded: starting a race on the circuit drew checkpoint
outlines hanging in mid-air over ground that had nothing on it, pointing at
gates that did not exist.

The other half of that bug is worth its own note. **The chosen map was persisted
by index**, and inserting the race map at position 0 silently repointed every
saved setting at a different track — someone who had chosen the circuit came
back to the gate run. An index is not an identifier; it is a fact about the
current order of a list. It is stored by name now, with a one-time migration
from the index era.

**Starting a race does not arm the quad**, and it says so: `NOT ARMED —
REMEMBER TO ARM` sits on the video through the countdown and beyond, until the
quad is armed. Without it the clock runs while the sticks do nothing and there
is no hint as to why — a disarmed quad on the ground looks exactly like an armed
one nobody is flying.

**The reset controls are off while a race runs.** Neither means anything then:
the respawn mode is forced in place for the duration, and "to start line" would
put the pilot behind every remaining checkpoint with the clock still running. A
control that is live but inert is a small lie.

**A crash mid-race recovers on its own.** After about a second — long enough
that the crash registers as one rather than as a glitch — the quad picks itself
up where it went in and carries on, armed. Nothing to press. The OSD says
YOU SUCK while it waits.

That pause and the automatic part are the point: with the clock running, a quad
lying on its back waiting for a keypress ends the race in practice. The lap is
void either way, so this makes a race finishable rather than cheaper.

It re-arms regardless of the throttle, which is the one place the usual
throttle-down rule is suspended: a racer is normally holding throttle when they
hit something, and respawning them disarmed just means they drop out of the sky
a second later.

**The respawn is always in place during a race**, whatever the reset selector
says. Sending a racer to the start line
ends the race in practice — the remaining checkpoints are behind them and the
lap is already void, so there is nothing left to do but abort. Outside a race
the selector is honoured, because "put me back at the start" is a reasonable
thing to want when you are not being timed.

### Colour

Every race gate is yellow, and the flag poles are yellow and white rather than
the traditional red and white. Red belongs to the wrong-way marker here: a large
red gate standing next to a small red warning is the one collision of meaning
worth avoiding, and gates are told apart by the counting blocks beside them
rather than by colour.

### Flag and gate

Two of the poles **are** one side of a gate — standing exactly where that post
would be, carrying on well above the top bar, one piece of scenery rather than
two things near each other.

That is what makes it an element rather than a jink. The pole and the gate share
the same line, so they cannot be taken in one pass: go over the gate, round the
pole, and back through the aperture, or the reverse depending on the order. Both
orders appear on the course, so a pilot meets each once a lap.

It was a pole a few metres off to the side at first, which made a jink and did
not read as one obstacle at all. Still no new checkpoint kind and no new
detector — it is a flag and a gate in sequence, and the geometry does the work.

A test asserts an attached pole sits exactly at the post position, and that a
free-standing one is well clear of every gate. Those are different invariants
and the first version of the test only knew about the second.

The **Race — six gates** map carries a course: six gates in order, then a flag
to circle. Set the lap count, press *Start race*, and the clock starts after a
three-second countdown.

**The course is drawn from the checkpoint list the timer uses** — `sixGateCourse`
in `src/race/course.ts` is the single source, so a gate cannot be drawn
somewhere the timer will not accept it. That is the whole class of bug that
makes a race feel broken rather than hard.

How a checkpoint is taken is shown rather than explained: chevrons on the ground
point the way through each gate, blocks beside it count out its number, and the
markers round the flag grow taller the way you are meant to turn.

**Which** checkpoint is next is drawn *on* the checkpoint: a gate has its
aperture outlined, a flag has a small arrow on the side it is passed. The
outline is **green from the side you take it from and red from the other**, so a
wrong approach is visible before you commit to it — which is what an arrow
through the aperture used to say, more loudly and while sitting on top of the
thing a pilot is trying to aim at. The colour is a draw-time uniform, so saying
it costs nothing per frame. Both are unlit and drawn with the depth test off, so they show through the
gate's own bar and through anything in the way — a deliberate cheat, since it is
a HUD element that happens to live in world space and a marker you cannot see is
not a marker.

The first version floated an arrowhead above the checkpoint, and a pilot's
verdict was that it was unclear. It was: a shape hanging in the air names no
gate, shows no aperture and gives no direction. Outlining the exact hole the
timer will accept makes the marker the instruction rather than a hint at one.

**Timing is on the video**, not beside it — clock, lap, next checkpoint and last
lap time top-left, battery, altitude and speed bottom-left, scaled up in
fullscreen. A pilot racing is looking at the picture, and in fullscreen the
picture is all there is.

### What it measures

| | |
|---|---|
| hole shot | start to the first gate |
| lap time | gate 1 to gate 1, through everything |
| best lap | fastest valid lap |
| best 3 consecutive | the figure racers actually quote; an invalid lap breaks the run rather than being skipped |
| splits | every checkpoint-to-checkpoint segment, with the fastest of each highlighted |

The splits are the point. A total time tells a pilot they were slow; the splits
tell them **where**, which is the difference between a stopwatch and a training
tool.

**Timing runs in the 1 kHz tick, and is interpolated rather than sampled.** At
25 m/s a tick moves 25 mm, so the quad is never exactly on the gate plane when
the tick fires — taking the tick time would add up to a millisecond of jitter
per gate for nothing. Reading it off the 30 Hz render loop instead would
quantise every split to 33 ms, which is most of the gap between a good lap and
a bad one.

**A respawn voids the lap it happened in**, marked ✗ and struck through. Without
that, a reset at the right moment is a shortcut and the timing measures nothing.

### The flag

**Go past it, this way, on this side, near enough.** That is one plane crossing
— the same test a gate uses, with the aperture on one side of the pole instead
of both. An arrow beside the pole shows which side and which way; a stripe on
the ground marks the corridor.

It was a swept angle first: stay inside a radius and turn 270° the right way.
That was wrong twice over, and a pilot found both. It was **unclear**, because a
circle drawn on the ground says "fly this shape" when the shape was never the
point. And it was **brittle**: a pilot flying round the drawn ring strayed
outside the radius, which silently reset the accumulated sweep, so it never
completed however many times they went round. A rule you can satisfy and still
fail is worse than a hard one.

The direction still matters — going past on the wrong side, too wide, or the
wrong way all fail — so circling the pole completes it only if the circle takes
the quad past on the required side. That is the rule working, not an edge case,
and there is a test for each half.

## Starting over

**Settings → Reset everything** puts every stored setting back to its default:
channel mapping and calibration, rates, PIDs and filters, camera and map.

It asks twice, and the arming lapses after a few seconds. That is deliberate
rather than fussy — it throws away a pilot's calibration, which is the most
tedious thing here to redo, and a mis-click should not be able to.

It finds the keys **by prefix**, not from a list. A hard-coded list is the
obvious way to write it and is wrong: the next feature that persists something
gets a key, nobody remembers to add it, and "reset all" quietly stops meaning
all. There is a check that seeds a key nobody has written yet and asserts it is
cleared anyway — and that keys the app does not own are left alone.

## Flying it without the keyboard

**Arm and reset bind to switches** (Settings → Channel mapping → Switches), so a
session runs entirely from the radio.

The two behave differently on purpose. **Arm is a level**, held on to fly, which
is what a flight controller does — flick it off in the air and you disarm in the
air, and that reflex is the point. **Reset is an edge**, fired once per flick,
because on a level it would respawn every tick.

A switch that is already on when the page loads **will not arm** until it has
been seen off once. Real flight controllers refuse for the same reason: nobody
wants a quad spooling up because a browser tab finished loading. Losing the
radio drops both the arm level and that guard, so a reconnection has to earn it
again.

Bindings read axes or buttons. Axes matter more: EdgeTX in USB Joystick mode
puts switches on the spare axes, so a TX16S reports eight and the four beyond
AETR are usually where the switches live.

## Three tabs, split by moment rather than by subject

**Go fly** is everything live: the FPV view with the sticks drawn over the
bottom-right corner, fullscreen, arm and reset, and the battery, altitude, speed
and current readouts. If you need it while flying, it is here.

**Settings** is what you do before flying: device, channel mapping and switch
bindings, and the diagnostics.

**Instruments** is for checking and tuning: the stick check, rates, PIDs and
filters, and the response bars. Nothing here is needed in the air.

The stick display follows the configured stick mode rather than assuming mode 2
— the mode presets are already known to be unreliable, and a display that lies
about which stick is which is worse than none.

Only the visible tab renders, so two WebGL contexts are not drawing frames
nobody can see. **The physics does not care**: it runs on the worker ticker, not
`requestAnimationFrame`, so ducking into Settings mid-flight does not freeze the
quad — there is a test asserting exactly that.

## The stick check

Where the artificial horizon used to be. A horizon is an aeroplane instrument
and reads wrong for a quad, but the more useful point is that pointing an
instrument at the flight model only repeats what the FPV view already says.

So the 3D quad is driven by **the sticks**, not the simulator, and answers one
question: did the channel mapping come out right? Push right, it banks right.
Push forward, the nose drops. If either is backwards you see it in a second
rather than discovering it on takeoff — which is exactly how the pitch
convention bug was found, by a pilot, after everyone had already flown it.

**It turns at your own rate curve.** Full stick rotates the model at exactly the
figure the rates panel quotes, in deg/s and rpm beside it, so a curve that is
wrong reads as a model that is too lazy or too frantic. An earlier version used
a made-up constant, which showed the direction and nothing else.

**It integrates, like acro.** Hold a stick and it keeps rotating; centre it and
it stays where it is. A first version sprang back to level, which is angle mode
— the one thing this simulator is not — and a stick check that behaves like a
mode the pilot never flies is checking the wrong thing. A *Level it* button
resets it when acro has left it somewhere unreadable.

There is a test for each direction: forward pitch drops the nose, right roll
drops the right wingtip, right yaw swings the nose right. Those read the model
matrix rather than the pixels, because the direction is the thing under test and
the pixels wobble with the prop rotation.

Throttle does not move it — there is no thrust and it hangs in space — but it
does drive the prop speed, so that channel can be checked in the same glance.

It shares `MeshBuilder` and the matrix helpers with the scene renderer rather
than introducing a second way of drawing things.

Editing PIDs applies about a second after the last keystroke. `applyTune()`
rebuilds the controller and so restarts the I-terms and filters; doing that per
keystroke would jolt the quad mid-air and would apply 1, then 12, then 120 while
someone typed "120".

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

**Everything runs on the pilot's machine.** Physics, rendering, gamepad polling,
log parsing and recording all happen in their browser, and persistence is
`localStorage`. The host serves six files, about 170 KB, once per visitor and
then does nothing — three pilots or three hundred is the same load.

**One thing does leave the browser**, and it is worth being exact about it,
because for most of this project's life nothing did. A short usage summary — how
long the pilot was *armed* on each map, their rates and PIDs, lap times, crash
count — is POSTed to the machine serving the page, so the person running a
feedback round can tell who actually flew it and on what. It is a summary and
not a stream: no inputs, no positions, nothing that could reconstruct a flight.
The pilot is a random id they can erase, plus a name they may type themselves.
The endpoint is a **relative** URL, so there is still no third party anywhere in
the built page — the only non-relative reference in it remains a `data:` URI
favicon. Settings has a toggle, on by default, that turns it off.

See [Who is flying it](#who-is-flying-it) for the collection and reading ends.

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
builds, Windows hands over the built files, and every byte of computation
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

Everything a pilot sets is kept in their own browser, under five keys:

| key | holds |
|---|---|
| `fpvsim.mappings.v1` | channel mapping and calibration, **per device id** |
| `fpvsim.tune.v1` | rate curve, PIDs, filters |
| `fpvsim.scene.v1` | FOV, camera tilt, map, reset mode |
| `fpvsim.tab.v1` | which tab was open |
| `fpvsim.pilot.v1` | the random pilot id, and the name if one was typed |
| `fpvsim.telemetry.v1` | the usage-sharing opt-out, written only when turned off |

Nothing is shared between pilots. The tune and the pilot id are the only parts
the host ever sees, and only through the usage summary described above — a pilot
who turns that off leaves the host knowing nothing about them at all.

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

The asymmetry is the design. The server hands over those files and then does
nothing at all; a second visitor costs it another 80 KB and no more. The client
runs a 1 kHz flight model and a renderer for about 6% of one core.

Serving over plain http to a LAN address costs the client *less* — 5.6% against
6.1% — which is not good news: the ticker has fallen back to a timer there and
is doing less work than it should.

### Who is flying it

The page posts a session summary to `/api/session` on the machine serving it;
`tools/serve.py` appends each one as a line of JSON to `data/sessions.jsonl`, and
`tools/admin.py` reads them back as one page. Three decisions in that are worth
keeping.

**The whole summary is resent as it grows**, on a 60 s heartbeat and again when
the tab goes away, with a session id attached. So a lost beacon costs nothing —
the newest record for a session supersedes the rest, and the reader takes the
last rather than adding them up. Summing would multiply every flight by the
number of heartbeats it survived. An unchanged summary is not resent at all,
which is what stops `pagehide` and `visibilitychange` — both of which fire when
a tab closes — from leaving two copies of it.

**The admin view's access control is its bind address**, and that is not
laziness. The Cloudflare tunnel connects to `127.0.0.1`, so *every tunnelled
visitor arrives as a local client*: a "is this request from localhost?" check
would have admitted the entire internet, and a secret path on port 5180 would be
carried by the tunnel like everything else. The tunnel forwards 5180 and only
5180, so 5181 has no route from the internet whatever it binds — which is the
whole protection, because the page itself has no password.

It runs on **`0.0.0.0:5181`** as deployed, so it is readable from the house
network at `http://192.168.7.54:5181/` — and by anything else on that network,
guest wifi included. That is a deliberate choice for a home LAN, not a general
recommendation. `admin.py --host 127.0.0.1` (or passing `127.0.0.1` to
`start-fpvsim.bat`) puts it back to the box alone, reached with a forward:

```
ssh -L 5181:127.0.0.1:5181 gilboash@hotmail.com@192.168.7.54
# then http://127.0.0.1:5181/
```

The page is read-only and has no controls, so the exposure is the data, not the
collection: nothing on that port can alter what is stored.

**Everything on that page is escaped**, because a pilot types their own name,
it arrives over an open POST endpoint, and the admin page is the one place it is
rendered back. A name of `<script>alert(1)</script>` is stored exactly as typed —
sanitising on the way in would have hidden the fact that the reader has to escape
on the way out — and the browser check asserts both halves of that.

One deploy trap came with the second server: the restart step stopped
returning. The bat detaches its servers with `Start-Process`, and with two of
them the SSH channel stays open behind them, so the deploy hangs *after having
already succeeded*. Redirecting the remote output does not help. The script
backgrounds that call and cuts it loose, then verifies over a fresh connection —
which is the honest thing to report anyway.

The deploy script excludes `data` from the `robocopy /MIR`. That line is
load-bearing: the box now holds state for this application where it previously
held none, and a mirror deletes whatever is not in the source, so without the
exclusion every deploy would silently erase the collection.

### Checking a deployment

`node tools/browser-check.mjs <url>` works against any of these. Against a dev
server it runs the full suite through a debug handle that only a dev build
carries; against a built artefact that handle is absent on purpose, and it
degrades to a smoke test — isolation, ticker backend, the banner matching the
environment, the scene actually drawing, and no page errors. Cross-origin
isolation is reported as a warning rather than a failure there, because it is a
property of the host rather than of the build.

## Licence

MIT — see `LICENSE`. Permissive because the point of this is that other pilots
can take it, and a hobby trainer is not worth a licence anyone has to think
about.

Three things in the tree are **not** covered, because they are not this
project's to license, and each is named in `LICENSE` rather than left for a
forker to discover:

- `src/assets/breaking-carbon.jpg` — Breaking Carbon's logo, a trademark used
  with permission for this instance. Remove it before redistributing.
- `src/assets/gong.m4a` — a sample supplied for the project, provenance not
  established here. Treat it as third-party.
- `measurements/` — Blackbox logs and jitter runs from real hardware. Data
  rather than software, kept so the numbers in this README can be checked.

## Related work on this machine

- `../genius-invester` — Flask + SQLite portfolio portal and a running
  pre-registered experiment. Worth reading for conventions rather than code:
  frozen parameters, append-only ledgers, and pre-committed criteria.
