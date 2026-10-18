// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How long the host waits on each method before it gives up. No wait crosses the wire, so the frame sizes its own work
// from the same budgets.

import type { AnyMethod } from '@dotli/transport';
import { protocolSchema } from './schema.js';

const DEFAULT_TIMEOUT_MS = 30_000;

const { frame, resolve, wallet, chain } = protocolSchema.traits;

/**
 * Methods bounded by chain sync or the user, not a timer. A smoldot panic rejects them through the frame's status, and
 * the user can abandon them from "Change settings".
 */
const UNTIMED_METHODS: ReadonlySet<AnyMethod> = new Set<AnyMethod>([frame.warmup]);

/** Budget per method in ms. */
const METHOD_TIMEOUTS: ReadonlyMap<AnyMethod, number> = new Map<AnyMethod, number>([
  [chain.connect, 30_000],
  [resolve.dotName, 90_000],
  [resolve.owner, 90_000],
  [resolve.executableManifest, 90_000],
  [resolve.rootManifest, 90_000],
  // Boot waits on it, so a protocol frame that does not load or answer must not hold the page for the default budget.
  [wallet.read, 5_000],
]);

/** How long the host waits on `method`, or null for one it waits on without a timer. */
export function budgetOf(method: AnyMethod): number | null {
  return UNTIMED_METHODS.has(method) ? null : (METHOD_TIMEOUTS.get(method) ?? DEFAULT_TIMEOUT_MS);
}

// Timed methods, so the default is never taken.
/** How long a chain connection may take to connect. */
export const CONNECT_BUDGET_MS = budgetOf(chain.connect) ?? DEFAULT_TIMEOUT_MS;
/** How long a name resolution may take to answer. */
export const RESOLVE_BUDGET_MS = budgetOf(resolve.dotName) ?? DEFAULT_TIMEOUT_MS;
