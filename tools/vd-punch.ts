/**
 * Measure the quad: one throttle punch from the pad, filmed, so the HUD speed
 * and the stick overlay can be read afterwards.
 *
 *   node --experimental-strip-types tools/vd-punch.ts <throttle> <hold s> <out dir> [--at 2.2]
 *
 * Start, wait for GO, then at GO + at seconds throttle = <throttle> for <hold>
 * seconds, then a hover-ish 0.25 and Reset. The sticks sent are logged
 * (punch.csv, t from GO) next to the screen recording (screen.mp4) and the
 * heard sounds (events.json).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStick, type Sticks } from './stick-port.ts';
import { listen } from './vd-audio.ts';
import { raceRunning, startSequence } from './vd-start.ts';

const argv = process.argv.slice(2);
const level = Number(argv[0]);
const hold = Number(argv[1] ?? 0.6);
const out = argv[2]!;
const AT = argv.includes('--at') ? Number(argv[argv.indexOf('--at') + 1]) : 2.2;
const THR_AFTER = argv.includes('--after') ? Number(argv[argv.indexOf('--after') + 1]) : 0.25;
mkdirSync(out, { recursive: true });

const clock = (): number => performance.now() / 1000;
const port = openStick(process.env.STICK_PORT);
const z: Sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
let sticks: Sticks = z;
let goAt = 0;
const sent: string[] = ['t,thr,roll,pitch,yaw'];
const feed = setInterval(() => {
  port.send(sticks);
  if (goAt) sent.push(`${(clock() - goAt).toFixed(4)},${sticks.throttle.toFixed(4)},${sticks.roll.toFixed(4)},${sticks.pitch.toFixed(4)},${sticks.yaw.toFixed(4)}`);
}, 4);

const running = raceRunning();
const film = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'avfoundation', '-capture_cursor', '0', '-pixel_format', 'uyvy422', '-framerate', '30', '-i', 'Capture screen 0:none', '-t', '16', '-vf', 'fps=30,scale=960:600', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', join(out, 'screen.mp4')], { stdio: ['pipe', 'ignore', 'inherit'] });
const filmT0 = clock();
const ears = listen(clock, {
  go: (at) => {
    goAt = at;
    console.log(`GO heard; punching ${level} for ${hold} s at +${AT}`);
    const wait = (s: number): number => Math.max(0, (at + s - clock()) * 1000);
    setTimeout(() => (sticks = { ...z, throttle: level }), wait(AT));
    setTimeout(() => (sticks = { ...z, throttle: THR_AFTER }), wait(AT + hold));
    setTimeout(end, wait(AT + hold + 2.5));
  },
});
startSequence((s) => (sticks = s), running, () => ears.arm());
setTimeout(() => {
  if (!goAt) {
    console.log('no GO heard');
    end();
  }
}, 12000);

let ended = false;
function end(): void {
  if (ended) return;
  ended = true;
  sticks = { ...z, buttons: 1 };
  setTimeout(() => {
    sticks = z;
    clearInterval(feed);
    ears.stop();
    film.stdin.write('q');
    writeFileSync(join(out, 'punch.csv'), sent.join('\n') + '\n');
    writeFileSync(join(out, 'events.json'), JSON.stringify({ goAt: goAt - filmT0, filmT0, events: ears.events.map(([a, l]) => [+(a - goAt).toFixed(3), +l.toFixed(2)]) }));
    setTimeout(() => {
      port.close();
      process.exit(0);
    }, 1500);
  }, 500);
}
