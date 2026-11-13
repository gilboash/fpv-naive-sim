# naco.fpvsim web sim: changelog

The web sim's release number is `version` in `package.json`. It is shown in the
header of `/web` and on the front page, and sent with each session report. Bump it
and add an entry here whenever what is deployed changes. The radio app, NacoSim,
has its own numbers and changelog in `edgetx/CHANGELOG.md`.

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
