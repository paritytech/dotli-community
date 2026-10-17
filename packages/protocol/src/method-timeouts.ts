// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Kept out of the client, which imports the config barrel, so the Playwright suite can read a budget from Node, where
// that barrel cannot load.

import type { RequestMethod, SubscriptionMethod } from './methods.js';

/** A method the host waits on: every request but the handshake, and every subscription. */
type CalledMethod = RequestMethod | SubscriptionMethod;

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Methods bounded by chain sync or the user, not a timer. A smoldot panic rejects them through the frame's status, and
 * the user can abandon them from "Change settings".
 */
const UNTIMED_METHODS: ReadonlySet<CalledMethod> = new Set<CalledMethod>(['warmup']);

/** Budget per method in ms. Handlers derive their sync budget from the deadline the call carries. */
const METHOD_TIMEOUTS: Partial<Record<CalledMethod, number>> = {
  chainConnect: 30_000,
  resolveDotName: 90_000,
  resolveOwner: 90_000,
  resolveExecutableManifest: 90_000,
  resolveRootManifest: 90_000,
  // Boot waits on it, so a protocol frame that does not load or answer must not hold the page for the default budget.
  localWalletRead: 5_000,
};

/** How long the host waits on `method`, or null for one it waits on without a timer. */
export function budgetOf(method: CalledMethod): number | null {
  return UNTIMED_METHODS.has(method) ? null : (METHOD_TIMEOUTS[method] ?? DEFAULT_TIMEOUT_MS);
}
