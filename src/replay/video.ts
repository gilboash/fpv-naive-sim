/**
 * Turn a flight into an MP4, in the browser: re-fly it, draw each frame, hand
 * the frames to the browser's own video encoder (WebCodecs), and pack the
 * result with mp4-muxer. No server, nothing uploaded; the file is made from
 * the stick recording in this tab and handed to the viewer as a download.
 *
 * 50 frames a second, because the physics runs at 1000 steps a second and 20
 * steps a frame is exact: frame n shows the flight after 20n ticks, with no
 * rounding drift over a long flight.
 *
 * Not real time: each frame waits for the one before, so a slow machine takes
 * longer and still gets every frame.
 */

import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { ReplayRun, type FlightTape } from './tape.ts';
import type { ReplayView } from './replay-view.ts';

export const VIDEO_FPS = 50;
const TICKS_PER_FRAME = 1000 / VIDEO_FPS;
const BITRATE = 4_000_000;

/** Codecs to try, best first: H.264 plays everywhere; VP9 in MP4 is the fallback. */
const CANDIDATES: { codec: string; mux: 'avc' | 'vp9' }[] = [
  { codec: 'avc1.640028', mux: 'avc' },
  { codec: 'avc1.4d0028', mux: 'avc' },
  { codec: 'avc1.42001f', mux: 'avc' },
  { codec: 'vp09.00.31.08', mux: 'vp9' },
];

/** Why this browser cannot make a video, or '' when it can. */
export function videoUnsupported(): string {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return 'This browser has no video encoder (WebCodecs). Chrome, Edge, recent Safari and recent Firefox do.';
  }
  return '';
}

async function pickCodec(width: number, height: number): Promise<(typeof CANDIDATES)[number] | null> {
  for (const c of CANDIDATES) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec: c.codec, width, height, bitrate: BITRATE, framerate: VIDEO_FPS });
      if (r.supported) return c;
    } catch {
      /* try the next */
    }
  }
  return null;
}

export interface VideoProgress {
  frame: number;
  frames: number;
}

/**
 * Re-fly `tape` and encode it. Resolves to the MP4; rejects if aborted or if
 * the encoder fails. `onProgress` is called every few frames.
 */
export async function makeVideo(
  tape: FlightTape,
  view: ReplayView,
  onProgress: (p: VideoProgress) => void,
  signal: AbortSignal,
): Promise<Blob> {
  const why = videoUnsupported();
  if (why) throw new Error(why);
  const { width, height } = view;
  const choice = await pickCodec(width, height);
  if (!choice) throw new Error('This browser cannot encode H.264 or VP9 video at this size.');

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: choice.mux, width, height, frameRate: VIDEO_FPS },
    fastStart: 'in-memory',
  });
  let failure: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      failure = e instanceof Error ? e : new Error(String(e));
    },
  });
  encoder.configure({
    codec: choice.codec,
    width,
    height,
    bitrate: BITRATE,
    framerate: VIDEO_FPS,
    latencyMode: 'quality',
    ...(choice.mux === 'avc' ? { avc: { format: 'avc' as const } } : {}),
  });

  const run = new ReplayRun(tape, view.prepare(tape));
  const frames = Math.max(1, Math.ceil(tape.ticks / TICKS_PER_FRAME) + 1);
  const yieldNow = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  try {
    for (let f = 0; f < frames; f++) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (failure) throw failure;
      run.runTo(f * TICKS_PER_FRAME);
      view.draw(run);
      const frame = new VideoFrame(view.out, { timestamp: Math.round((f * 1e6) / VIDEO_FPS), duration: Math.round(1e6 / VIDEO_FPS) });
      encoder.encode(frame, { keyFrame: f % (VIDEO_FPS * 2) === 0 });
      frame.close();
      // Keep the encoder's queue short, so memory stays flat on a long flight.
      while (encoder.encodeQueueSize > 4) await yieldNow();
      if (f % 10 === 0) {
        onProgress({ frame: f, frames });
        await yieldNow();
      }
    }
    await encoder.flush();
    if (failure) throw failure;
    muxer.finalize();
    onProgress({ frame: frames, frames });
    return new Blob([target.buffer], { type: 'video/mp4' });
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
}
