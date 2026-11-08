/**
 * Live frames of the game, from the screen, as RGB24.
 *
 * ffmpeg's avfoundation screen capture, cropped to the picture (the game
 * letterboxes 1440x900 to 16:9, 5% top and bottom), scaled to 480x270 and
 * piped raw. Optionally also written to a video file for the post-mortem.
 * The game must be the visible Space — this captures the screen, not a
 * window.
 */

import { spawn } from 'node:child_process';

export const FW = 480;
export const FH = 270;

export function frames(onFrame: (rgb: Uint8Array, t: number) => void, opts: { fps?: number; record?: string } = {}): () => void {
  const fps = opts.fps ?? 30;
  const args = [
    '-loglevel', 'error',
    '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '32',
    '-f', 'avfoundation', '-capture_cursor', '0', '-pixel_format', 'uyvy422', '-framerate', String(fps),
    '-i', 'Capture screen 0:none', // by name: the index moves when an iPhone camera comes and goes
    '-filter_complex', `[0]fps=${fps},crop=iw:ih*0.9:0:ih*0.05,split=2[a][b];[a]scale=${FW}:${FH}[o];[b]scale=960:-2[r]`,
    '-map', '[o]', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ];
  if (opts.record) args.push('-map', '[r]', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-y', opts.record);
  else args.splice(args.indexOf('-filter_complex') + 1, 1, `[0]fps=${fps},crop=iw:ih*0.9:0:ih*0.05,scale=${FW}:${FH}[o]`);
  const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const size = FW * FH * 3;
  let buf = Buffer.alloc(0);
  ff.stdout.on('data', (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= size) {
      // Only the newest complete frame matters; a backlog is latency.
      const n = Math.floor(buf.length / size);
      const start = (n - 1) * size;
      const f = new Uint8Array(buf.subarray(start, start + size));
      buf = buf.subarray(n * size);
      onFrame(f, performance.now());
    }
  });
  return () => {
    ff.stdin.write('q');
    ff.stdin.end();
  };
}
