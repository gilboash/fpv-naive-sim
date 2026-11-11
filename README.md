# naco.fpvsim

A free FPV trainer you can fly anywhere, built on one idea: **the stick feel has
to be right before anything else.** There are two ways to use it:

| | What it is | Get it |
|---|---|---|
| **NacoSim for your radio** | A small quad simulator that runs as a Lua script on an **EdgeTX radio's own screen**, with your real sticks and your own rates. No computer, no cable. | [Copy `edgetx/SCRIPTS/` to the SD card](#nacosim-on-your-edgetx-radio) |
| **The web sim** | A 5" racing quad in your browser, flown with your own radio as a USB joystick: a flight model checked against real Blackbox logs, race tracks, gates, flags, lap timing, sound. | [`npm install && npm run dev`](#the-web-sim) |

## NacoSim on your EdgeTX radio

A rate-mode quad with a wireframe view, gates and flags, a lap timer, gate
beeps, a settings menu (sound, track, laps, camera tilt, your Betaflight rates)
and seven tracks, including MultiGP qualifier courses. Tested on a **Jumper T14**
(EdgeTX 2.10, black and white) and a **RadioMaster TX16S** (EdgeTX 2.11.5,
colour); other radios are untested and reports are welcome.

**Install**

1. Put the radio in **USB Storage** mode (or take the SD card out), so the card
   shows up as a drive.
2. Copy the **contents of [`edgetx/SCRIPTS/`](edgetx/SCRIPTS)** onto the card's
   `SCRIPTS` folder, merging with what is there. You should end up with:

   ```
   SCRIPTS/TOOLS/NacoSim.lua     the sim: open it from the radio's Tools menu
   SCRIPTS/TOOLS/NacoMem.lua     a memory check, for if it says "not enough memory"
   SCRIPTS/NacoSim/              the sim's parts (model, course, view, display, settings)
   SCRIPTS/NacoSim/maps/         the tracks, one .map file each
   ```

3. Eject the card and open **NacoSim** from the **Tools** menu. Bring the throttle
   to zero to arm. **MENU** (or a PAGE key, or a tap on a touch radio) opens the
   settings; **ENTER** respawns; **EXIT** leaves.

If it stops with `not enough memory`, run it from an empty model: an ELRS model
leaves a script less memory. Everything about flying it, the settings, adding your
own tracks and reporting a problem is in **[`edgetx/README.md`](edgetx/README.md)**,
and what changed in each release is in **[`edgetx/CHANGELOG.md`](edgetx/CHANGELOG.md)**.

A ready-made zip of the same files is on the project site's `/rc` page, or build
it here with `npm run build` (it is written to `dist/downloads/`).

The track layouts of Macabim and the MultiGP 2024 qualifiers were designed by
others and were converted for practice; see the credits in
[`edgetx/README.md`](edgetx/README.md#tracks).

## The web sim

```
npm install
npm run dev        # http://localhost:5180
```

The site has three pages: `/` is the front page, **`/web` is the sim**, and `/rc`
is the radio page with pictures and the download. Put your radio in **USB
Joystick** mode, plug it in, open `/web`, then **move a stick**: browsers hide a
gamepad from a page until they see activity.

What it has:

- **A flight model you can trust the feel of.** Blade-element rotors, brushless
  motors with battery sag and a Betaflight-scaled PID loop, stepping at 1 kHz
  inside the input tick. It is calibrated against Blackbox logs from real quads;
  the timing matches well and the amplitude has a known, written-down gap.
- **Your rates and your tune.** Betaflight, Actual and KISS rate curves, and the
  option to import a whole tune (rates, PIDs, filters) from a Blackbox header.
- **Racing.** Gates, flags and cubes, lap timing with a result screen, a
  next-gate marker, an on-screen display, motor sound, and a fullscreen view that
  works on a phone.
- **Your own tracks**, written as plain data and kept in your browser.

The long story of how each part was built and checked, including the known gaps,
is in **[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)**.

## Developing

```
npm run build          # typecheck + production build (also builds the radio zip)
npm run check:flight   # physical acceptance tests for the flight model, headless
npm run check:browser  # drives the real page over CDP (needs `npm run dev`)
npm run check:rc       # the front, /web and /rc pages, their images and the radio zip
npm run check:events   # the visit and download counting, end to end

brew install lua       # or your package manager, for the radio sim's tests:
lua edgetx/test/run.lua      # model, race, settings, drawing
lua edgetx/test/sizes.lua    # the whole tool on seven screen sizes, mono and colour
```

| Where | What |
|---|---|
| `src/` | the web sim: flight model (`src/flight`, pure TypeScript), renderer, race mode, UI |
| `edgetx/` | NacoSim for EdgeTX: the scripts (`SCRIPTS/`), tests, release notes, README |
| `public/nacosim/` | the pictures on the radio page, drawn from the sim's own screens |
| `tools/` | the checks, the server (`serve.py`) and its stats page (`admin.py`), the map converter |
| `docs/` | the development write-up |
| `CLAUDE.md` | working notes: decisions, traps and how it is deployed |

`./deploy-windows.sh` deploys to the box that hosts the site (it has a dry-run
mode); how that box is set up is in `CLAUDE.md`.

## Status

The input timing (a 1 kHz loop reading a radio that reports at about 200 Hz) and
the flight model are signed off, the scene and race mode are built, and the radio
sim has been flown on two radios. The model's known gaps (response amplitude,
especially in pitch) are listed in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)
rather than left out.

## Licence

MIT, see `LICENSE`. Permissive because the point of this is that other pilots can
take it, and a hobby trainer is not worth a licence anyone has to think about.

Some things in the tree are **not** covered, because they are not this project's
to license, and each is named in `LICENSE` rather than left for a forker to
discover:

- `src/assets/breaking-carbon.jpg`: Breaking Carbon's logo, a trademark used with
  permission for this instance. Remove it before redistributing.
- `src/assets/gong.m4a`: a sample supplied for the project, provenance not
  established here. Treat it as third-party.
- `measurements/`: Blackbox logs and jitter runs from real hardware. Data rather
  than software, kept so the numbers in the write-up can be checked.
- The track layouts in `edgetx/SCRIPTS/NacoSim/maps/` other than Race vibes:
  gate layouts of tracks designed by others, converted from their Velocidrone
  files for practice. If you made one and would rather it was not here, say so
  and it will be removed.
