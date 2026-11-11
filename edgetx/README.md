# NacoSim for EdgeTX

A tiny rate-mode FPV quad simulator that runs on the radio itself, flown with
the real sticks. Wireframe view, gates, lap timer, your own Betaflight rates.
Pure Lua, no PC or cable needed.

## Install

1. Put the radio in **USB Storage** mode (or take the SD card out) so the SD
   card shows up as a drive.
2. Copy the `SCRIPTS` folder from this directory onto the SD card, merging with
   the existing `SCRIPTS` folder. You should end up with:
   - `SCRIPTS/TOOLS/NacoSim.lua`
   - `SCRIPTS/NacoSim/` (`model.lua`, `course.lua`, `view.lua`, `display.lua`, `settings.lua`)
3. Eject, then open it from the radio's **Tools** menu (how you reach Tools
   depends on the radio: see its EdgeTX manual).

Developed and tested on a Jumper T14 running EdgeTX 2.10. Other radios and
other EdgeTX versions are untested, see below.

## Flying

- Sticks are read as they are in the model's setup. Throttle must be at zero to
  arm ("THR DOWN" until it is).
- **ENTER** respawns, **EXIT** leaves.
- **MENU** (or a PAGE key, or a tap on touch radios) opens the settings. The
  quad pauses while it is open.
- A race is 3 laps by default, timed from your first pass of gate 1 to the pass
  that completes the last lap. Top right is the race clock, bottom right the
  last lap. A beep marks each gate and a long beep the finish.
- The yellow diamond marks the next gate when it is on screen; at the edge an
  arrow points to it when it is not.

## Settings

Sound on/off, map, number of laps, camera tilt, rates (presets or edit each
axis: rate, super, expo) and an **Info** screen. Settings are saved on the SD
card, in `SCRIPTS/NacoSim/settings.txt`, tagged with a format version (`v4,...`).
Older files are migrated when you update; a file from a newer NacoSim than the
one installed is ignored, so downgrading never misreads your settings. The
NacoSim version and settings format are shown on the Info screen and written
at the top of the logs. Rates default to a 5" quad at 512 / 439 / 429 deg/s.

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
white) that has only been tested against a simulated API, not real hardware.
Expect rough edges there and please report them.

## Developing

Needs a desktop `lua` (`brew install lua`). From the repository root:

    lua edgetx/test/run.lua     # model, course, race, settings (incl. versions), drawing checks
    lua edgetx/test/tool.lua    # the tool script against a stub radio
    lua edgetx/test/sizes.lua   # the whole tool on mono and colour screens,
                                # strict about the LCD API and the screen edge
    lua edgetx/test/cost.lua    # Lua instructions per frame

The tool and sizes tests hide Lua's `table` and `os` libraries because the
radio does not have them: do not use them in anything under `SCRIPTS/`.

`model.lua`, `course.lua` and the settings logic never touch the screen.
Everything that differs between radios (size, fonts, colours, how many lines
to draw) is in `display.lua`.
