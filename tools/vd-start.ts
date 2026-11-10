/**
 * The start of every Velocidrone run, shared: is a race running (the purple
 * button reads START or ABORT), and the button sequence that ends in a fresh
 * countdown. GO itself is heard, not timed (vd-audio.ts).
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Sticks } from './stick-port.ts';

export function raceRunning(): boolean {
  for (let k = 0; k < 3; k++) {
    try {
      const win = execFileSync('osascript', ['-l', 'JavaScript', '-e', `
        ObjC.import("CoreGraphics"); const arr = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0)); let id = "";
        for (let i = 0; i < arr.count; i++) { const w = arr.objectAtIndex(i);
          if (ObjC.unwrap(w.objectForKey("kCGWindowOwnerName")) === "velocidrone" && ObjC.unwrap(w.objectForKey("kCGWindowName")) === "velocidrone") id = ObjC.unwrap(w.objectForKey("kCGWindowNumber")); }
        id`]).toString().trim();
      const a = join(tmpdir(), 'vd-start-btn.png');
      const b = join(tmpdir(), 'vd-start-btn-c.png');
      execFileSync('screencapture', ['-x', '-o', '-r', `-l${win}`, '-t', 'png', a]);
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', a, '-vf', 'crop=iw*0.094:ih*0.04:iw*0.453:ih*0.873,negate', b]);
      const txt = execFileSync('tesseract', [b, '-', '--psm', '7'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().toUpperCase();
      console.log(`race button reads "${txt.trim()}"`);
      if (txt.includes('BORT')) return true;
      if (txt.includes('START')) return false;
    } catch {
      // try again
    }
  }
  return false;
}

/**
 * Throttle nudge (the game reads an axis only once it moves), Reset,
 * Recharge, [abort], Race Start. Times in ms from now; `arm` at Race Start.
 */
export function startSequence(set: (s: Sticks) => void, running: boolean, arm: () => void): void {
  const z: Sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
  const at = (ms: number, f: () => void): void => void setTimeout(f, ms);
  at(100, () => set({ ...z, throttle: 0.1 }));
  at(200, () => set(z));
  at(300, () => set({ ...z, buttons: 1 })); // Reset
  at(450, () => set(z));
  at(900, () => set({ ...z, buttons: 4 })); // Recharge
  at(1200, () => set(z));
  if (running) {
    at(1600, () => set({ ...z, buttons: 2 })); // abort
    at(1900, () => set(z));
  }
  at(2600, () => {
    arm();
    set({ ...z, buttons: 2 }); // Race Start
  });
  at(3000, () => set(z));
}
