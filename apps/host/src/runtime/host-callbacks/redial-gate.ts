// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Each product's papi client re-follows every 250 ms and each dial would boot a frame or rebuild a chain, so redials
// after a halt go through one gate shared by every core connection.

const REDIAL_FIRST_MS = 1_000;
const REDIAL_MAX_MS = 30_000;

export interface RedialGate {
  /** What the last dial reached halted. */
  noteHalt(): void;
  /** Whether a dial may go now, which shuts the gate for the next delay. */
  tryDial(): boolean;
}

/**
 * The first redial after a halt goes at once, the next waits 1 s and each later one twice as long, up to 30 s. Only
 * uptime resets the wait: a halt more than 30 s after the last dial redials at once again.
 */
export function createRedialGate(): RedialGate {
  let opensAt: number | null = null;
  let delay = 0;
  let dialedAt: number | null = null;

  return {
    noteHalt() {
      const now = Date.now();
      // What the last dial reached outlived the longest wait, so it recovered.
      if (dialedAt !== null && now - dialedAt > REDIAL_MAX_MS) {
        dialedAt = null;
        delay = 0;
        opensAt = now;
        return;
      }
      // A window shut by a dial stays, one left in the past is armed again from this halt.
      if (opensAt === null || opensAt <= now) {
        opensAt = now + delay;
      }
    },
    tryDial() {
      const now = Date.now();
      if (opensAt !== null && now < opensAt) {
        return false;
      }
      delay = Math.min(Math.max(delay * 2, REDIAL_FIRST_MS), REDIAL_MAX_MS);
      opensAt = now + delay;
      dialedAt = now;
      return true;
    },
  };
}
