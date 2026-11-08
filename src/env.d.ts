/**
 * Build-time constants. `__FPVSIM_BUILD__` is substituted by the `define` in
 * vite.config.ts, so it is a literal in the bundle rather than something read
 * at runtime — there is nothing to fetch and nothing to fail.
 */
declare const __FPVSIM_BUILD__: string;

/**
 * Audio assets Vite hashes into the build. Declared here because `vite/client`
 * does not cover every container, and an undeclared import is a type error
 * rather than a runtime one — which is the right way round.
 */
declare module '*.m4a' {
  const src: string;
  export default src;
}

/**
 * Velocidrone tracks imported on this machine — under `npm run dev` only; a
 * production build resolves this to an empty list (see vite.config.ts).
 */
declare module 'virtual:local-tracks' {
  import type { SavedVdTrack } from './render/velocidrone.ts';
  const tracks: SavedVdTrack[];
  export default tracks;
}
