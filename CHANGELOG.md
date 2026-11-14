# naco.fpvsim web sim: changelog

The web sim's release number is `version` in `package.json`. It is shown in the
header of `/web` and on the front page, and sent with each session report. Bump it
and add an entry here whenever what is deployed changes. The radio app, NacoSim,
has its own numbers and changelog in `edgetx/CHANGELOG.md`.

## 1.4.0 (2026-11-14)

- **A real sky:** deep blue overhead fading to haze at the horizon, the sun where the
  light on the scene comes from, and scattered clouds. It is constant: drawn once when
  the page opens, so it costs nothing per frame.
- **Hangars and industrial chimneys on Freestyle and Freestyle hard**, out beyond the
  existing furniture:
  - three kinds of hangar: a pitched-roof hangar with big front doors, a small back
    door and beams across the inside; a round Quonset hut with skylights and a back
    door; and a flat-roofed hangar with doors on several sides, columns inside and
    skylights in the roof grid. Every roof has holes you can fly up or drop through.
  - industrial chimneys in seven sizes across the two maps, from a 1.3 m bore to a
    48 m stack with aviation bands: dive in at the top and fly out through the opening
    at the foot.
- **Fixed: R did nothing after picking a map** (or a motion blur level): the dropdown
  kept keyboard focus and the shortcuts ignored it, so after a crash the only way back
  was To start line. R, A, D and M now work with a dropdown focused.
- **Fixed: binding a switch** took longer than the 2.5 s it asks for (about 4.7 s here),
  because its timer mixed two clocks. The same fix applies to stick detection and the
  jitter test.

## 1.3.0 (2026-11-13)

- **Motion blur**, on at medium by default; Settings → Video sets it to off, light,
  medium or strong.
  Blur as a camera's exposure makes it, from the quad's speed and turn rate: the ground
  close under a fast quad smears, distant gates stay sharp, and a fast flip swirls the
  edges of the picture. Light, medium and strong are 4, 8 and 14 ms of exposure. The
  streak is capped so a gate never smears away, and the next-gate marker and the OSD
  are never blurred.
- **Grass detail:** the ground has a fine texture close up, which gives a better sense
  of speed and height near the ground, with or without blur.

## 1.2.0 (2026-11-13)

- **Four famous tracks:** Macabim and the MultiGP 2024 qualifiers #1, #2 and #3, in the
  Map list after the 180s. They are the same layouts as on the radio, built from its map
  files, at their real gate sizes, which are smaller than this sim's other gates. The
  layouts are their designers' work, converted from Velocidrone for practice; sizes,
  directions and flag sides are estimates. Macabim's drop-through gate is not included.
  The MultiGP micro track is left out: its gates are sized for tiny whoops.
- **Your own tracks:** two checkpoints at one spot are allowed when they are flown in
  opposite directions (out and back round one pole). The timer only confused them when
  they were flown the same way.

## 1.1.0 (2026-11-13)

- **Sound: "on, no gong".** The sound button now has three states: on, on without the
  gong, and off. Without the gong, hitting a gate or pole is silent and every other
  sound stays: motors, crashes, gate chimes. Also a checkbox in Settings, Sound. M still
  mutes and unmutes, and keeps your gong choice.

## 1.0.0 (2026-11-13)

The first numbered release. Everything before it is unnumbered; see the git history.

- **Less floaty.** The props now drag on the air the way real ones do (rotor drag 5x
  stronger). A hovering quad scrubs off sideways speed about four times faster, turns
  grip, and it slows sooner when you chop the throttle. Top speed is 47 m/s
  (about 170 km/h), from 52.
- **Anti-gravity**, as in Betaflight 4.5: the quad holds its attitude better while the
  throttle moves fast. Uses your tune's anti-gravity gain.
- **Respawn at the last gate.** Settings, Reset to: "last gate passed". In a race, a
  reset or crash puts you on the ground just past the last checkpoint you cleared,
  facing the next one. Outside a race it respawns where you are.
- **NacoSim label** in the top-right corner of the picture, as on the radio.
- **Header:** the Race Drones logo on the right, Breaking Carbon next to the title,
  a link back to the front page, and the release number.
