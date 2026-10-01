// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// When the host pool may dial again something that keeps dying: a protocol
// frame after a frame halt, or one chain after its own halt. Each product's
// papi client re-follows every 250 ms, and each of those dials would boot a
// frame or rebuild a chain, so the dials go through a gate shared by every
// core connection.

const REDIAL_FIRST_MS = 1_000;
const REDIAL_MAX_MS = 30_000;

export interface RedialGate {
  /** What the last dial reached halted. */
  noteHalt(): void;
  /** Whether a dial may go now. One that may shuts the gate and doubles the delay, up to 30 s. */
  tryDial(): boolean;
  /** End the current wait, keeping the delay. */
  open(): void;
}

/**
 * A gate whose first halt waits `firstWaitMs` (1 s for a frame, 0 for a
 * chain). Each dial through it shuts it for the next delay, 1 s at least,
 * doubling to 30 s. A halt with the gate already shut keeps it shut; one that
 * finds it open in the past arms it again from the halt. Only uptime resets
 * it: a halt more than 30 s after the last dial through the gate waits
 * `firstWaitMs` again, and the delay starts over.
 */
export function createRedialGate(firstWaitMs: number): RedialGate {
  let opensAt: number | null = null;
  let delay = firstWaitMs;
  /** When the last dial went through the gate. */
  let dialedAt: number | null = null;

  return {
    noteHalt() {
      const now = Date.now();
      // What the last dial reached lived past the longest wait: it recovered.
      if (dialedAt !== null && now - dialedAt > REDIAL_MAX_MS) {
        dialedAt = null;
        delay = firstWaitMs;
        opensAt = now + delay;
        return;
      }
      // A window already shut by a dial stays; one left in the past (by a live
      // frame's refusal, say) is armed again from this halt.
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
    open() {
      opensAt = null;
    },
  };
}
