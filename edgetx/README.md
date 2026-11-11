# NacoSim for EdgeTX

A tiny rate-mode FPV quad simulator that runs on the radio itself, flown with
the real sticks. Wireframe view, gates, lap timer, your own Betaflight rates.
Pure Lua, no PC or cable needed.

## Install

1. Put the radio in **USB Storage** mode (or take the SD card out) so the SD
   card shows up as a drive.
2. Copy the `SCRIPTS` folder from this directory onto the SD card, merging with
   the existing `SCRIPTS` folder. You should end up with:
   - `SCRIPTS/TOOLS/NacoSim.lua` (and `NacoMem.lua`, the memory check)
   - `SCRIPTS/NacoSim/` (`model.lua`, `course.lua`, `view.lua`, `display.lua`, `settings.lua`)
   - `SCRIPTS/NacoSim/maps/` (the tracks, one `.map` file each)
3. Eject, then open it from the radio's **Tools** menu (how you reach Tools
   depends on the radio: see its EdgeTX manual).

Tested on a **Jumper T14** (EdgeTX 2.10, black and white screen) and a
**RadioMaster TX16S** (EdgeTX 2.11.5, colour screen). Other radios and other
EdgeTX versions are untested, see below.

## Memory: use a light model, or "not enough memory"

NacoSim is a big Lua script for a radio. EdgeTX gives scripts a small heap, and
what is left depends on the **model that is active**: a model set up for a real
receiver (ELRS with telemetry and its sensors) leaves less than an empty one.
On a T14, NacoSim ran from an empty model (named SIM) but stopped at start-up
with `NacoSim.lua:44 not enough memory` when an ELRS model was selected.

A colour radio has far more room: on a TX16S (EdgeTX 2.11.5, empty SIM model)
NacoMem showed NacoSim's parts taking about 64 KB with more than 400 KB still
free. A T14 has not been measured with NacoMem yet.

Until it is made lighter:

- **Select an empty model first** (one with no module, no telemetry sensors and
  few mixes, such as a "SIM" model you create for it) and run NacoSim from there.
  You can switch back to your flying model afterwards.
- If it still says `not enough memory`, run **NacoMem** from the Tools menu on the
  model you use. It loads NacoSim's parts one by one and reports what each costs
  and how much heap is left, on screen and in `LOGS/nacomem.txt`. Send us that
  file with the radio and EdgeTX version.
- `LOGS/nacosim_boot.txt` says how far NacoSim got before it stopped.

## Flying

- Sticks are read as they are in the model's setup. Throttle must be at zero to
  arm ("THR DOWN" until it is).
- **ENTER** respawns, **EXIT** leaves.
- **MENU** (or a PAGE key, or a tap on touch radios) opens the settings. The
  quad pauses while it is open.
- A race is 3 laps by default, timed from your first pass of gate 1 to the pass
  that completes the last lap. Top right is the race clock, bottom right the
  last lap. A beep marks each gate and a long beep the finish.
- The yellow diamond marks the next gate when it is on screen, with a short
  arrow along the way through it; at the edge of the screen an arrow points to
  it when it is not. If you are on the **wrong side** of the gate (flying at it
  would cross it backwards and not count) the marker gets an **X**.
- Gates are drawn and timed **25% bigger** than the map file says
  (`C.GATE_SCALE` in `course.lua`); the picture and the timer use the same size.

## Settings

Sound on/off, map (every `.map` file in `SCRIPTS/NacoSim/maps`, plus the built-in Oval), number of laps, camera tilt, rates (presets or edit each
axis: rate, super, expo) and an **Info** screen. Settings are saved on the SD
card, in `SCRIPTS/NacoSim/settings.txt`, tagged with a format version (`v4,...`).
Older files are migrated when you update; a file from a newer NacoSim than the
one installed is ignored, so downgrading never misreads your settings. The
NacoSim version and settings format are shown on the Info screen and written
at the top of the logs. Rates default to a 5" quad at 512 / 439 / 429 deg/s.

## Tracks

A track is one small text file in `SCRIPTS/NacoSim/maps/`; copy a `.map` file
there and it appears in the **Map** setting. The choice is saved by file name.
A map holds upright gates and flags (a pole you pass on one side). Format,
one record per line, `#` starts a comment:

    nacosim-map 1
    name Race vibes
    start <x east> <y north> <heading deg>
    g <x> <y> <z> <heading> <half width> <half height>       an upright gate
    f <x> <y> <pole height> <heading> <side 1|-1> <pass width>   a flag

Metres, x east, y north, z up; heading is the compass direction of travel
through the checkpoint. Gate sizes in a map are the real ones; NacoSim makes
gates 25% bigger. Flags are forgiving: NacoSim doubles a flag's pass width
(`C.FLAG_SCALE`) and lets you clip the wrong side of the pole by a metre
(`C.FLAG_GRACE`). A flag with side `1` is passed on the **right** of the
pole, `-1` on the left. Lap one starts at the first checkpoint, and a lap ends
when you pass it again. Up to 80 checkpoints per map.

Tracks from the web sim (or a Velocidrone import) are converted with
`npm run edgetx:map -- --builtin "Race vibes"` or
`npm run edgetx:map -- --course course.json --name my-track`. Cube
drop-throughs (horizontal gates) are skipped and reported, and obstacles are not
carried across. Velocidrone tracks stored in the game's newer encoded format
cannot be read by the importer, so they cannot be converted. Maps in
`SCRIPTS/NacoSim/maps/` are tracked and ship in the zip. `edgetx/maps-local/` is
git-ignored, for maps that should stay private: the zip build adds them when it
is built on a machine that has them.

**Credits.** Race vibes is this project's own. Macabim and the MultiGP 2024
qualifier and micro tracks are the gate layouts of tracks designed by others,
converted from their Velocidrone files for practice; the sizes, directions and
flag sides are estimates. If you made one of them and would rather it was not
here, say so and it will be removed.

## Helping test on another radio

Please open **Settings > Info** and note what it says (radio, EdgeTX version,
screen size, fps), then tell us:

- does it start, and does the picture fit your screen (nothing cut off)?
- do MENU, the wheel/keys, ENTER and EXIT all work, which key opens settings?
- is it smooth? Info shows frames per second and ms per frame.
- anything that looks wrong or crashes.

Two files on the SD card help us find problems: `LOGS/nacosim.csv` (a flight
log, one line per frame) and `LOGS/nacosim_last.txt` (the last state, and any
error). Send them with your report.

Colour radios use a separate drawing path (coloured lines instead of black and
white). It has been tried on a TX16S, where it works; other colour radios are
untested, so expect some rough edges there and please report them.

## Developing

Needs a desktop `lua` (`brew install lua`). From the repository root:

    lua edgetx/test/run.lua     # model, course, race, settings (incl. versions), drawing checks
    lua edgetx/test/tool.lua    # the tool script against a stub radio
    lua edgetx/test/sizes.lua   # the whole tool on mono and colour screens,
                                # strict about the LCD API and the screen edge
    lua edgetx/test/cost.lua    # Lua instructions per frame, worst checkpoint of every map
    lua edgetx/test/mem.lua     # the NacoMem probe against a stub radio
    lua edgetx/test/snap.lua out.html race-vibes:2:0 ...   # what the screen shows, as an image

The tool and sizes tests hide Lua's `table` and `os` libraries because the
radio does not have them: do not use them in anything under `SCRIPTS/`.

`model.lua`, `course.lua` and the settings logic never touch the screen.
Everything that differs between radios (size, fonts, colours, how many lines
to draw) is in `display.lua`.
