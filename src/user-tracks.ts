/**
 * Tracks a pilot wrote, kept in their own browser.
 *
 * Deliberately client-side, and that is the design rather than a shortcut.
 * A track someone is still working on is theirs; it does not belong on anyone
 * else's machine, it cannot break a map another pilot is flying, and there is
 * no upload endpoint to secure. When a track is good enough to be permanent it
 * goes to Gilboa as a file or a pull request and becomes a built-in — which is
 * a review step rather than a bottleneck, because until then it already works.
 *
 * Stored under `fpvsim.tracks.v1`, so the prefix-based **Reset everything**
 * clears it along with the rest without knowing it exists.
 */

import { TRACKS, trackFromSpec, type Track } from './render/track.ts';
import { validateTrackSpec, type TrackSpec, type ValidationResult } from './render/track-spec.ts';
import { checkTrack } from './render/track-check.ts';

const STORAGE_KEY = 'fpvsim.tracks.v1';

interface Stored {
  version: 1;
  tracks: TrackSpec[];
}

let cache: TrackSpec[] | null = null;

/** The specs this browser holds. Read once and kept; saving replaces it. */
export function userSpecs(): TrackSpec[] {
  if (cache) return cache;
  cache = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Stored;
      if (s.version === 1 && Array.isArray(s.tracks)) {
        // Re-validated on the way *out*, not only on the way in. Stored data
        // was written by an older build with different limits, and localStorage
        // is editable by anyone with a console open.
        for (const t of s.tracks) {
          const v = validateTrackSpec(t, builtInNames());
          if (v.ok && v.spec) cache.push(v.spec);
        }
      }
    }
  } catch {
    // A corrupt store costs the custom tracks, not the page.
  }
  return cache;
}

function builtInNames(): string[] {
  return TRACKS.map((t) => t.name);
}

function persist(specs: TrackSpec[]): void {
  cache = specs;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, tracks: specs } satisfies Stored));
  } catch {
    /* private mode, quota — not worth failing over */
  }
}

/**
 * Add or replace a track from JSON text.
 *
 * Replacing by name rather than appending, because saving an edited track is
 * the common case and a list of near-identical names would be the result
 * otherwise. Names are identity here, as they are for the built-in maps.
 */
export function saveUserTrack(json: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { ok: false, errors: [`not valid JSON — ${(e as Error).message}`], spec: null };
  }
  const result = validateTrackSpec(parsed, builtInNames());
  if (!result.ok || !result.spec) return result;
  const spec = result.spec;

  // Well-formed is not the same as flyable. A spec can be perfectly valid JSON
  // and still put a gate inside a tower or the start line in a wall, and the
  // pilot finds out by flying into it. Building it and looking is cheap.
  const check = checkTrack(trackFromSpec(spec));
  if (!check.ok) return { ok: false, errors: check.errors, spec: null, warnings: check.warnings };
  const next = userSpecs().filter((t) => t.name !== spec.name);
  next.push(spec);
  persist(next);
  // Warnings travel with a *successful* save: they are the pilot's call, and
  // refusing on them would make the check something to work around.
  return { ...result, warnings: check.warnings };
}

export function deleteUserTrack(name: string): void {
  persist(userSpecs().filter((t) => t.name !== name));
}

/** One pilot's track as the JSON they would send on. */
export function exportUserTrack(name: string): string | null {
  const spec = userSpecs().find((t) => t.name === name);
  return spec ? JSON.stringify(spec, null, 2) : null;
}

/**
 * Every map: the built-in ones and then the pilot's own.
 *
 * Built-ins first and in their existing order, because the first entry is what
 * a new visitor lands on and that is a decision the project has already made
 * twice — once by accident, when inserting a map at the front silently
 * repointed everyone's stored setting.
 */
export function allTracks(): Track[] {
  return [...TRACKS, ...userSpecs().map(trackFromSpec)];
}

/** A starting point for someone opening the box for the first time. */
export const EXAMPLE_TRACK = `{
  "version": 1,
  "name": "My first track",
  "start": { "north": -30, "east": 0, "yawDeg": 0 },
  "laps": 3,
  "pieces": [
    { "type": "cube", "north": 18, "east": 14, "storeys": 2 },
    { "type": "pole", "north": 6, "east": -16, "height": 12 },
    { "type": "roundChimney", "north": -8, "east": 18, "radius": 1.6, "base": 5, "height": 11 }
  ],
  "course": [
    { "gate": { "north": -14, "east": 0, "heading": 0 } },
    { "gate": { "north": 6, "east": 8, "heading": 20 } },
    { "flag": { "north": 24, "east": -6, "heading": 180, "side": 1 } },
    { "gate": { "north": 2, "east": -12, "heading": 200 } }
  ]
}`;
