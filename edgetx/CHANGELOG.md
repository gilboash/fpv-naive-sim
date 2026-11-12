# NacoSim for EdgeTX: release notes

The version is in **Settings > Info** and at the top of the logs
(`LOGS/nacosim.csv`), and is the number in the zip's file name. When you report
something, say which one you have.

## 0.7.2
- Also tested by other pilots on a RadioMaster TX15 and a RadioMaster Pocket;
  the Pocket now starts from an empty model with no memory error.
- **New track: Freestyle poles.** Orbit practice with flags on tall poles: a
  figure-eight round two poles, one loop round a three-pole tripod, and a full
  orbit of a 40 m mast. The radio has no solid poles or dive gates, so there is no
  chimney in it; each orbit is four flag passes on the same pole, in order.

- **"Not enough memory" on small radios (RadioMaster Pocket).** The biggest part
  is now compiled first, while the most memory is free, and a part that fails to
  load is retried once. If it still fails you get a message on screen (run
  **NacoMem** once from Tools, then open NacoSim again) instead of a raw error.
- **A reset about a second after starting** is fixed if it was the key that
  launched the tool arriving as an ENTER: keys are ignored for the first second.
  If you still see it, send `LOGS/nacosim.csv`.
- **Updating:** delete the old `.luac` files (in `SCRIPTS/TOOLS` and
  `SCRIPTS/NacoSim`) after copying. The zip's files have a fixed date, so the
  radio can keep running old compiled code. (A tester reported the dates; the
  stale-code effect itself was not seen.)

## 0.7.1
- **Every zip now has all seven tracks.** In 0.7.0 the five tracks other than Oval
  and Race vibes were only in a zip built on one computer, so some people unzipped
  a 0.7.0 with just two. If yours lists only Oval and Race vibes, download this one.
- The download page lists the tracks that are really in the zip.
- Race vibes shows its proper name in Settings > Info.
- Credits for the tracks that other people designed (see the README).

## 0.7.0
- **Flags are more forgiving.** The pass width is doubled, you can clip the wrong
  side of the pole by a metre, and a pass at a shallow angle from the side counts.
- **Five more tracks:** Macabim, MGP Qualifier 2024 1, 2 and 3, and MGP Micro 2024.
- A long track name is cut to fit the Map row instead of running off the screen.

## 0.6.1
- **Which way through a gate:** the marker on the next gate has an arrow along the
  way through it, and a red X when you are on the wrong side (flying at it would
  not count).
- **Gates are 25% bigger**, drawn and timed alike.
- **NacoMem**, a tool that reports how much Lua memory a model leaves a script.
  Start-up is staged and writes `LOGS/nacosim_boot.txt`.

## 0.6.0
- **Tracks are files** in `SCRIPTS/NacoSim/maps`, chosen in the Map setting and
  saved by name (settings format 5; older settings are migrated). A map holds
  gates and flags.
- Race vibes, converted from the web sim.
- Settings format versions: a file from a newer NacoSim is ignored, an older one is
  migrated.

## 0.5.0
- **Settings menu** (MENU key, a PAGE key, or a tap on touch radios): sound, map,
  laps, camera tilt, rates (presets or per axis) and an Info screen.
- **Lap timing:** a race is 3 laps by default, timed from the first pass of gate 1,
  with a result screen listing the total and each lap.
- A screen profile for black-and-white and colour radios (tested on a T14 and a
  TX16S), and the NacoSim name on the screen.

## 0.1 to 0.4 (not released)
The rate-mode quad model, the wireframe view, gates with a gate-pass beep, and the
logging that found the first problems on a real radio.
