/**
 * Velocidrone controller setup, driven from here while a person clicks.
 *
 * Holds the joystick (sticks centred, throttle at mid) and can read the game's
 * window a few times a second. When the game asks for a stick by name — its
 * "Assign Sticks" flow — that stick is moved through its full travel until
 * the prompt changes. Commands can also be dropped into a file, one per line:
 *
 *   press N        hold button N (1-8) for 0.6 s
 *   wiggle AXIS    throttle | yaw | pitch | roll, 2.5 s
 *   hold T R P Y S hold a position for S seconds
 *   rest T R P Y   where the sticks sit between actions (default: all
 *                  centred, throttle at mid — what a stick-assignment wizard
 *                  wants to see between steps)
 *   ocr on|off     whether to read the screen and react (default off)
 *   click X Y      left-click at X, Y in the game window's own points (as
 *                  on a 1440-wide screenshot). Refused unless Velocidrone is
 *                  the frontmost app and the point is inside its window —
 *                  the board is a mouse to the OS, so this check is the only
 *                  thing scoping it to the game.
 *   quit
 *
 * One process holds the joystick for the whole session on purpose. Separate
 * scripts let the firmware's failsafe drop the throttle between them, and the
 * jump back to centre at the start of the next one moved the throttle axis
 * at the same moment as the stick being assigned — Velocidrone took it.
 *
 *   node --experimental-strip-types tools/vd-setup.ts <window-id> <command-file> <log>
 *
 * Only the game's window is captured (`screencapture -l`), never the screen.
 */

import { execFileSync } from 'node:child_process';

/** The frontmost app's name and the game window's bounds, in screen points. */
function frontAndWindow(id: string): { front: string; win: [number, number, number, number] | null; screen: [number, number] } {
  const js = `
    ObjC.import('AppKit'); ObjC.import('CoreGraphics');
    const front = ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.localizedName);
    const arr = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0));
    let win = null;
    for (let i = 0; i < arr.count; i++) {
      const w = arr.objectAtIndex(i);
      if (ObjC.unwrap(w.objectForKey('kCGWindowNumber')) == ${Number(id)}) {
        const b = w.objectForKey('kCGWindowBounds');
        win = ['X','Y','Width','Height'].map(k => ObjC.unwrap(b.objectForKey(k)));
      }
    }
    const f = $.NSScreen.mainScreen.frame;
    JSON.stringify({ front, win, screen: [f.size.width, f.size.height] });`;
  return JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', js]).toString());
}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { openStick, type Sticks, switchMode } from './stick-port.ts';

const [winId, cmdFile, logFile] = process.argv.slice(2) as [string, string, string];
const shot = `${logFile}.jpg`;
const log = (s: string): void => appendFileSync(logFile, `${new Date().toISOString().slice(11, 23)} ${s}\n`);
writeFileSync(cmdFile, '');
writeFileSync(logFile, '');

let port = openStick(process.env.STICK_PORT);
log(`stick on ${port.path}`);

const centre: Sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
let rest: Sticks = { throttle: 0.5, roll: 0, pitch: 0, yaw: 0 };
let ocrOn = false;
type Action = { until: number; at: (t: number) => Sticks; name: string };
let action: Action | null = null;
const t0 = performance.now();
const now = (): number => (performance.now() - t0) / 1000;

function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // the firmware holds the last stick frame meanwhile
  }
}

function wiggle(axis: string, secs = 2.5): void {
  const start = now();
  const at = (t: number): Sticks => {
    const v = Math.sin((2 * Math.PI * (t - start)) / 1.2);
    if (axis === 'throttle') return { ...rest, throttle: (v + 1) / 2 };
    return { ...rest, [axis]: v };
  };
  action = { until: start + secs, at, name: `wiggle ${axis}` };
  log(`-> wiggle ${axis}`);
}

let lastText = '';
let lastAsked = '';
let nextShot = 0;
let cmdSeen = 0;
let ocrBusy = false;

function ocr(): void {
  try {
    execFileSync('screencapture', ['-x', '-o', '-r', `-l${winId}`, '-t', 'jpg', shot]);
    const text = execFileSync('tesseract', [shot, '-', '--psm', '11'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .replace(/\s+/g, ' ')
      .trim();
    const words = (x: string): Set<string> => new Set(x.toUpperCase().match(/[A-Z]{4,}/g) ?? []);
    const a0 = words(lastText);
    const a1 = words(text);
    const diff = [...a1].filter((w) => !a0.has(w)).length + [...a0].filter((w) => !a1.has(w)).length;
    if (diff > 3) {
      log(`screen: ${text.slice(0, 400)}`);
      lastText = text;
    }
    // The game names the stick it wants; move that one, once per prompt.
    const up = text.toUpperCase();
    const asked = ['THROTTLE', 'YAW', 'PITCH', 'ROLL'].find((a) => new RegExp(`\\b(MOVE|ASSIGN|SELECT)\\b[^.]{0,40}\\b${a}\\b`).test(up));
    if (asked && asked !== lastAsked) {
      lastAsked = asked;
      wiggle(asked.toLowerCase());
    }
    if (!asked) lastAsked = '';
  } catch (e) {
    log(`capture failed: ${String(e).slice(0, 120)}`);
  }
}

function commands(): boolean {
  if (!existsSync(cmdFile)) return true;
  const lines = readFileSync(cmdFile, 'utf8').split('\n').filter((l) => l.trim());
  for (; cmdSeen < lines.length; cmdSeen++) {
    const [c, ...a] = lines[cmdSeen]!.trim().split(/\s+/);
    log(`command: ${lines[cmdSeen]}`);
    if (c === 'quit') return false;
    if (c === 'press') {
      const n = Math.max(1, Math.min(8, Number(a[0] ?? 1)));
      const start = now();
      action = { until: start + 0.6, at: () => ({ ...rest, buttons: 1 << (n - 1) }), name: `press ${n}` };
    } else if (c === 'wiggle') {
      wiggle(a[0] ?? 'throttle');
    } else if (c === 'rest') {
      const [T, R, P, Y] = a.map(Number);
      rest = { throttle: T ?? 0.5, roll: R ?? 0, pitch: P ?? 0, yaw: Y ?? 0 };
    } else if (c === 'click') {
      const x = Number(a[0]);
      const y = Number(a[1]);
      const st = frontAndWindow(winId);
      const [wx, wy, ww, wh] = st.win ?? [0, 0, 0, 0];
      if (!st.front.toLowerCase().includes('velocidrone')) {
        log(`click refused: frontmost app is ${st.front}`);
      } else if (!st.win || !(x >= 0 && y >= 0 && x <= ww && y <= wh)) {
        log(`click refused: ${x},${y} is outside the game window`);
      } else {
        const fx = (wx + x) / st.screen[0];
        const fy = (wy + y) / st.screen[1];
        port = switchMode(port, true);
        busyWait(400); // let macOS register the new pointer
        // Hover first: a Unity button only takes a press it has seen the
        // pointer arrive over, a frame or more earlier.
        port.mouse(fx, fy, 0);
        busyWait(250);
        port.mouse(fx, fy, 1);
        busyWait(120);
        port.mouse(fx, fy, 0);
        busyWait(150);
        port = switchMode(port, false);
        log(`clicked ${x},${y}`);
      }
    } else if (c === 'ocr') {
      ocrOn = a[0] === 'on';
    } else if (c === 'hold') {
      const [T, R, P, Y, S] = a.map(Number);
      const start = now();
      action = { until: start + (S ?? 3), at: () => ({ throttle: T ?? 0, roll: R ?? 0, pitch: P ?? 0, yaw: Y ?? 0 }), name: 'hold' };
    }
  }
  return true;
}

// 250 Hz frames; the screen read and the command file are checked between them.
let next = performance.now();
for (;;) {
  const t = now();
  if (action && t > action.until) {
    log(`done: ${action.name}`);
    action = null;
  }
  port.send(action ? action.at(t) : rest);
  if (t > nextShot && !ocrBusy) {
    nextShot = t + 0.4;
    ocrBusy = true;
    // Blocking, and longer than the firmware's 250 ms failsafe, so never in
    // the middle of moving a stick.
    if (!action && ocrOn) ocr();
    ocrBusy = false;
    if (!commands()) break;
  }
  next += 4;
  if (performance.now() > next + 50) next = performance.now();
  while (performance.now() < next) {
    // busy-wait, as in stick.ts
  }
}
port.send(centre);
port.close();
log('quit');
