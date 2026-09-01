/**
 * Build-time constants. `__FPVSIM_BUILD__` is substituted by the `define` in
 * vite.config.ts, so it is a literal in the bundle rather than something read
 * at runtime — there is nothing to fetch and nothing to fail.
 */
declare const __FPVSIM_BUILD__: string;
