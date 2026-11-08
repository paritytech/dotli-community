// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A chain that halts each time it is rebuilt would otherwise be re-synced on each redial, and a frame that fails each
// boot booted again. The gates are kept across rebuilds, since they hold back every lease of the pool.

import { realTimers, type Timers } from '@dotli/shared';
import type { RemoteChainHalt } from './chainHaltError.js';
import { createRedialGate, type RedialGate } from './createRedialGate.js';
import { isChainUp, type ConnectionStatus } from './transportHooks.js';

type Params = {
  /** The pool's status of a chain, so a halted lease joins a chain already rebuilt without waiting. */
  status: (key: string) => ConnectionStatus;
  /** Whether the frame every transport of the pool rides is down. */
  isFrameDown: () => boolean;
  /** The clock the gates wait on. The page's own by default. */
  timers?: Pick<Timers, 'now'>;
};

/** One pool's redial, as its factory builds it. */
export type ChainRedial = ReturnType<typeof createChainRedial>;

/**
 * Holds back the redials of a pool's halted leases, one gate per chain and one for the frame. A `'frame'` halt waits on
 * the frame gate only while the frame is down, since a lease taken then boots it. Each `key` is a chain's lowercase
 * genesis hash.
 */
export function createChainRedial({ status, isFrameDown, timers = realTimers }: Params) {
  const frameGate = createRedialGate({ timers });
  const chainGates = new Map<string, RedialGate>();

  return {
    /** Notes that a lease on `key` halted for `reason`. Never throws. */
    noteHalt(key: string, reason: RemoteChainHalt): void {
      switch (reason) {
        case 'frame':
          frameGate.noteHalt();
          getChainGate(key).noteHalt();
          return;
        case 'chain':
          getChainGate(key).noteHalt();
          return;
      }
    },
    /**
     * Returns whether a lease that halted for `reason` may take `key` now, and shuts that gate for its next wait when
     * it may. Never throws.
     */
    tryDial(key: string, reason: RemoteChainHalt): boolean {
      return canJoin(key, reason) || getGate(key, reason).tryDial();
    },
    /** Returns the ms until `tryDial` may pass for `reason`, 0 when it may now. Never throws. */
    waitMs(key: string, reason: RemoteChainHalt): number {
      return canJoin(key, reason) ? 0 : getGate(key, reason).waitMs();
    },
    /**
     * Returns whether a lease that halted for `reason` and has since failed to take `key` may try again now, on its
     * gate alone even while the chain is up, and shuts that gate for its next wait when it may. Never throws.
     */
    tryDialGate(key: string, reason: RemoteChainHalt): boolean {
      return getGate(key, reason).tryDial();
    },
    /** Returns the ms until `tryDialGate` may pass for `reason`, 0 when it may now. Never throws. */
    gateWaitMs(key: string, reason: RemoteChainHalt): number {
      return getGate(key, reason).waitMs();
    },
  };

  function getGate(key: string, reason: RemoteChainHalt): RedialGate {
    switch (reason) {
      case 'frame':
        return isFrameDown() ? frameGate : getChainGate(key);
      case 'chain':
        return getChainGate(key);
    }
  }

  // A chain another lease already rebuilt is joined free, unless the frame it rode is still down.
  function canJoin(key: string, reason: RemoteChainHalt): boolean {
    switch (reason) {
      case 'frame':
        return !isFrameDown() && isChainUp(status(key));
      case 'chain':
        return isChainUp(status(key));
    }
  }

  function getChainGate(key: string): RedialGate {
    let gate = chainGates.get(key);
    if (gate === undefined) {
      gate = createRedialGate({ timers });
      chainGates.set(key, gate);
    }
    return gate;
  }
}
