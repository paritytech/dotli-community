// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How long the host waits on each method before it gives up. No wait crosses the wire, so the frame sizes its own work
// from the same budgets.

import type { MethodName, TraitName } from '@dotli/transport';
import { callName, type CallName } from './call-names.js';
import type { ProtocolSchema } from './schema.js';

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

/** How long the host waits on `method` of `trait`, or null for one it waits on without a timer. */
export function budgetOf<T extends TraitName<ProtocolSchema>>(
  trait: T,
  method: MethodName<ProtocolSchema, T>,
): number | null {
  const name = callName(trait, method);
  return UNTIMED_METHODS.has(name) ? null : (METHOD_TIMEOUTS[name] ?? DEFAULT_TIMEOUT_MS);
}

// Timed methods, so the default is never taken.
/** How long a chain connection may take to connect. */
export const CONNECT_BUDGET_MS = budgetOf('chain', 'connect') ?? DEFAULT_TIMEOUT_MS;
/** How long a name resolution may take to answer. */
export const RESOLVE_BUDGET_MS = budgetOf('resolve', 'dotName') ?? DEFAULT_TIMEOUT_MS;
