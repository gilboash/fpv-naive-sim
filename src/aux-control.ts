/**
 * Turning two switches into arm and reset.
 *
 * The two actions deliberately behave differently, because a switch is a level
 * and the two actions are not the same kind of thing:
 *
 *   arm    A level, evaluated every tick, exactly as a flight controller reads
 *          its arm switch. Held on to fly; flick it off in the air and you
 *          disarm in the air. That is the reflex a pilot already has and the
 *          one worth transferring.
 *
 *   reset  An edge. Respawning is an event, and on a level it would fire every
 *          tick the switch was held, which is a thousand respawns a second.
 *
 * Runs in the 1 kHz tick, so it allocates nothing and does no DOM work.
 */

import { auxActive, type Mapping } from './mapping.ts';

export interface AuxState {
  /** Is the arm switch on right now? */
  armOn: boolean;
  /** Did the reset switch go from off to on this tick? */
  resetEdge: boolean;
  /**
   * False until the arm switch has been seen off at least once. See the guard
   * in update() — this is the whole reason the flag exists.
   */
  armReady: boolean;
}

export class AuxControl {
  readonly state: AuxState = { armOn: false, resetEdge: false, armReady: false };
  private prevReset = false;

  /**
   * Forget what the switches were doing. Called when the device changes, since
   * a binding on the old radio says nothing about the new one — and in
   * particular the arm guard has to be re-earned.
   */
  reset(): void {
    this.state.armOn = false;
    this.state.resetEdge = false;
    this.state.armReady = false;
    this.prevReset = false;
  }

  update(
    mapping: Mapping,
    axes: readonly number[],
    buttons: readonly number[],
    linkUp: boolean,
  ): AuxState {
    const st = this.state;
    st.resetEdge = false;

    if (!linkUp) {
      // No link is no input, as everywhere else. Also drop the arm guard: when
      // the radio comes back the switch has to be seen off again before it can
      // arm, which is the safe reading of a reconnection.
      st.armOn = false;
      st.armReady = false;
      this.prevReset = false;
      return st;
    }

    const armRaw = auxActive(mapping.aux.arm, axes, buttons);

    // Arm only after the switch has been seen off once.
    //
    // Open the page with the switch already up and, without this, the quad
    // would arm the instant the browser saw the radio — before the pilot had
    // looked at the screen, and with no action from them at all. Real flight
    // controllers refuse for exactly this reason. The cost is one flick of the
    // switch on arrival, which is also what a pilot does at the field.
    if (!armRaw) st.armReady = true;
    st.armOn = armRaw && st.armReady;

    const resetRaw = auxActive(mapping.aux.reset, axes, buttons);
    st.resetEdge = resetRaw && !this.prevReset;
    this.prevReset = resetRaw;

    return st;
  }
}
