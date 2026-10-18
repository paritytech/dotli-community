// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How long the host waits on each method before it gives up. No wait crosses the wire, so the frame sizes its own work
// from the same budgets.

import type { CallName } from './call-names.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Methods bounded by chain sync or the user, not a timer. A smoldot panic rejects them through the frame's status, and
 * the user can abandon them from "Change settings".
 */
const UNTIMED_METHODS: ReadonlySet<CallName> = new Set<CallName>(['warmup']);

/** Budget per method in ms. */
const METHOD_TIMEOUTS: Partial<Record<CallName, number>> = {
  chainConnect: 30_000,
  resolveDotName: 90_000,
  resolveOwner: 90_000,
  resolveExecutableManifest: 90_000,
  resolveRootManifest: 90_000,
  // Boot waits on it, so a protocol frame that does not load or answer must not hold the page for the default budget.
  localWalletRead: 5_000,
};

/** How long the host waits on `method`, or null for one it waits on without a timer. */
export function budgetOf(method: CallName): number | null {
  return UNTIMED_METHODS.has(method) ? null : (METHOD_TIMEOUTS[method] ?? DEFAULT_TIMEOUT_MS);
}

// Timed methods, so the default is never taken.
/** How long a chain connection may take to connect. */
export const CONNECT_BUDGET_MS = budgetOf('chainConnect') ?? DEFAULT_TIMEOUT_MS;
/** How long a name resolution may take to answer. */
export const RESOLVE_BUDGET_MS = budgetOf('resolveDotName') ?? DEFAULT_TIMEOUT_MS;
