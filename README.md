# fpvsim

Browser-based FPV drone simulator for skill training, flown with a real RC
transmitter over USB. See the project brief for the full scope; first target is
a single 5" racing quad and a few simple maps with basic track obstacles.

**Current phase: M1 — flight model.** M0 (input spike) is signed off: the tick
source holds 1 kHz on real hardware and the radio was measured at 201.8 Hz. M1
adds the flight model itself — blade-element rotors, brushless motors, battery
sag, and a Betaflight-scaled PID loop, stepping at 1 kHz inside the input tick.
Still no 3D scene, deliberately: per the brief the feel has to be right before
any art exists, and the instrument panel is how you judge it in the meantime.

## Run it

```
npm install
npm run dev            # http://localhost:5180 (or whatever Vite prints)
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
- The ground is a plane with friction, not a contact model. No prop strikes and
  no tumbling on impact — crashes are a later milestone. The first recorded
  flight hit the ground at 27 m/s and simply carried on flying, so this is now
  a demonstrated gap rather than an anticipated one, and half that flight was
  spent within 0.5 m of the ground.
- Rate mode only. No angle or horizon mode, which is what the brief is about.
- Under 20 s of sustained full-deflection stick reversal the model tumbles past
  4 000 deg/s. The gyro clips at 2 000 deg/s exactly as real hardware does, and
  it recovers when the sticks centre, but the peak is higher than a real quad
  reaches and is worth revisiting once there is a log to compare against.

## Related work on this machine

- `../genius-invester` — Flask + SQLite portfolio portal and a running
  pre-registered experiment. Worth reading for conventions rather than code:
  frozen parameters, append-only ledgers, and pre-committed criteria.
