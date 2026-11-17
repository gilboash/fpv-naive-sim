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
 *
 * With sound, the sound track is made first (src/replay/sound.ts: the page's
 * own synthesis, re-driven from a second re-fly, offline) and encoded as AAC,
 * or Opus where the browser has no AAC encoder. A browser that can do neither
 * gets the video without sound rather than no video.
 */

import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { ReplayRun, type FlightTape } from './tape.ts';
import { renderFlightSound, SOUND_RATE, soundUnsupported } from './sound.ts';
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
  /** Making the sound track first, then the pictures. */
  stage: 'sound' | 'video';
  frame: number;
  frames: number;
}

export interface VideoOptions {
  /** A sound track: the page's motor sound, chimes and crashes. */
  sound: boolean;
  /** The gong on hitting scenery, as the page's Sound setting has it. */
  gong: boolean;
}

/** Audio codecs to try: AAC plays everywhere; Opus in MP4 is the fallback. */
const AUDIO_CANDIDATES: { codec: string; mux: 'aac' | 'opus' }[] = [
  { codec: 'mp4a.40.2', mux: 'aac' },
  { codec: 'opus', mux: 'opus' },
];
const AUDIO_BITRATE = 128_000;

async function pickAudioCodec(): Promise<(typeof AUDIO_CANDIDATES)[number] | null> {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined' || soundUnsupported()) return null;
  for (const c of AUDIO_CANDIDATES) {
    try {
      const r = await AudioEncoder.isConfigSupported({ codec: c.codec, sampleRate: SOUND_RATE, numberOfChannels: 1, bitrate: AUDIO_BITRATE });
      if (r.supported) return c;
    } catch {
      /* try the next */
    }
  }
  return null;
}

/** What the last makeVideo did about sound, for the panel and the checks. */
export let lastSound: 'aac' | 'opus' | 'none' | 'unsupported' = 'none';

/**
 * Re-fly `tape` and encode it. Resolves to the MP4; rejects if aborted or if
 * the encoder fails. `onProgress` is called every few frames.
 */
export async function makeVideo(
  tape: FlightTape,
  view: ReplayView,
  onProgress: (p: VideoProgress) => void,
  signal: AbortSignal,
  opts: VideoOptions = { sound: true, gong: true },
): Promise<Blob> {
  const why = videoUnsupported();
  if (why) throw new Error(why);
  const { width, height } = view;
  const choice = await pickCodec(width, height);
  if (!choice) throw new Error('This browser cannot encode H.264 or VP9 video at this size.');

  const obstacles = view.prepare(tape);
  const frames = Math.max(1, Math.ceil(tape.ticks / TICKS_PER_FRAME) + 1);
  const seconds = frames / VIDEO_FPS;

  // The sound track is rendered whole before the first frame, from a re-fly of
  // its own, then handed to the encoder a frame's worth at a time so the file
  // comes out interleaved.
  const audioChoice = opts.sound ? await pickAudioCodec() : null;
  lastSound = !opts.sound ? 'none' : audioChoice ? audioChoice.mux : 'unsupported';
  let pcm: Float32Array | null = null;
  if (audioChoice) {
    pcm = await renderFlightSound(tape, obstacles, seconds, { gong: opts.gong }, (f) => onProgress({ stage: 'sound', frame: Math.round(f * frames), frames }), signal);
  }

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: choice.mux, width, height, frameRate: VIDEO_FPS },
    ...(audioChoice ? { audio: { codec: audioChoice.mux, numberOfChannels: 1, sampleRate: SOUND_RATE } } : {}),
    fastStart: 'in-memory',
  });
  let failure: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      failure = e instanceof Error ? e : new Error(String(e));
    },
  });
  const audioEncoder = audioChoice
    ? new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => {
          failure = e instanceof Error ? e : new Error(String(e));
        },
      })
    : null;
  audioEncoder?.configure({ codec: audioChoice!.codec, sampleRate: SOUND_RATE, numberOfChannels: 1, bitrate: AUDIO_BITRATE });
  const samplesPerFrame = SOUND_RATE / VIDEO_FPS;
  const encodeSound = (f: number): void => {
    if (!audioEncoder || !pcm) return;
    const from = f * samplesPerFrame;
    if (from >= pcm.length) return;
    const data = pcm.slice(from, Math.min(pcm.length, from + samplesPerFrame));
    const ad = new AudioData({
      format: 'f32-planar',
      sampleRate: SOUND_RATE,
      numberOfFrames: data.length,
      numberOfChannels: 1,
      timestamp: Math.round((from * 1e6) / SOUND_RATE),
      data,
    });
    audioEncoder.encode(ad);
    ad.close();
  };
  encoder.configure({
    codec: choice.codec,
    width,
    height,
    bitrate: BITRATE,
    framerate: VIDEO_FPS,
    latencyMode: 'quality',
    ...(choice.mux === 'avc' ? { avc: { format: 'avc' as const } } : {}),
  });

  const run = new ReplayRun(tape, obstacles);
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
      encodeSound(f);
      // Keep the encoder's queue short, so memory stays flat on a long flight.
      while (encoder.encodeQueueSize > 4) await yieldNow();
      if (f % 10 === 0) {
        onProgress({ stage: 'video', frame: f, frames });
        await yieldNow();
      }
    }
    await encoder.flush();
    if (audioEncoder) await audioEncoder.flush();
    if (failure) throw failure;
    muxer.finalize();
    onProgress({ stage: 'video', frame: frames, frames });
    return new Blob([target.buffer], { type: 'video/mp4' });
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close();
  }
}
