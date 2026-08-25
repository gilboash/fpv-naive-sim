/**
 * Stick position to angular-rate setpoint, in Betaflight's own curves.
 *
 * These are ported from Betaflight's src/main/fc/rc.c rather than approximated,
 * so a pilot can type the numbers off their own radio and get their own feel.
 * That is the whole point of a trainer: the muscle memory has to transfer.
 */

import { clamp } from './math.ts';

export type RateType = 'actual' | 'betaflight';

export interface RateProfile {
  type: RateType;
  /** Per axis: roll, pitch, yaw. */
  rcRate: [number, number, number];
  /** "Super" rate for betaflight-type, max rate/10 for actual-type. */
  rate: [number, number, number];
  /** Expo, 0..100 as shown in the configurator. */
  expo: [number, number, number];
}

export const AXIS_ROLL = 0;
export const AXIS_PITCH = 1;
export const AXIS_YAW = 2;

/**
 * Betaflight's default Actual Rates for a 5" — 200 deg/s around centre rising
 * to 800 deg/s at the stops. Fast enough to be a racing quad, not so fast that
 * a new pilot cannot find centre.
 */
export function defaultRates(): RateProfile {
  return {
    type: 'actual',
    rcRate: [20, 20, 20],
    rate: [80, 80, 80],
    expo: [54, 54, 54],
  };
}

const RC_RATE_INCREMENTAL = 14.54;

function applyActual(rcRate: number, rate: number, expoPct: number, cmd: number): number {
  const absCmd = Math.abs(cmd);
  const expof = expoPct / 100;
  const shaped = absCmd * (Math.pow(cmd, 5) * expof + cmd * (1 - expof));
  const centreSensitivity = rcRate * 10;
  const stickMovement = Math.max(0, rate * 10 - centreSensitivity);
  return cmd * centreSensitivity + stickMovement * shaped;
}

function applyBetaflight(rcRateIn: number, rate: number, expoPct: number, cmd: number): number {
  const absCmd = Math.abs(cmd);
  let c = cmd;
  if (expoPct) {
    const expof = expoPct / 100;
    c = c * Math.pow(absCmd, 3) * expof + c * (1 - expof);
  }
  let rcRate = rcRateIn / 100;
  if (rcRate > 2.0) rcRate += RC_RATE_INCREMENTAL * (rcRate - 2.0);
  let angleRate = 200 * rcRate * c;
  if (rate) {
    const superFactor = 1 / clamp(1 - absCmd * (rate / 100), 0.01, 1.0);
    angleRate *= superFactor;
  }
  return angleRate;
}

/** Stick command in [-1,1] to setpoint in deg/s. */
export function applyRates(p: RateProfile, axis: number, cmd: number): number {
  const c = clamp(cmd, -1, 1);
  return p.type === 'actual'
    ? applyActual(p.rcRate[axis]!, p.rate[axis]!, p.expo[axis]!, c)
    : applyBetaflight(p.rcRate[axis]!, p.rate[axis]!, p.expo[axis]!, c);
}

/** Rate at full stick, for display and for sanity checks. */
export function maxRate(p: RateProfile, axis: number): number {
  return applyRates(p, axis, 1);
}
