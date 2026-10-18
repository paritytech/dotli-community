// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How long the host waits on each method before it gives up. No wait crosses the wire, so the frame sizes its own work
// from the same budgets.

import type { AnyMethod } from '@dotli/transport';
import { protocolSchema } from './schema.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/** How long a chain connection may take to connect. */
export const CONNECT_BUDGET_MS = 30_000;
/** How long a name resolution may take to answer. */
export const RESOLVE_BUDGET_MS = 90_000;

const { frame, resolve, wallet, chain } = protocolSchema.traits;

/**
 * Budget per method in ms. Null is a method bounded by chain sync or the user, not a timer: a smoldot panic rejects it
 * through the frame's status, and the user can abandon it from "Change settings".
 */
const METHOD_TIMEOUTS: ReadonlyMap<AnyMethod, number | null> = new Map<AnyMethod, number | null>([
  [frame.warmup, null],
  [chain.connect, CONNECT_BUDGET_MS],
  [resolve.dotName, RESOLVE_BUDGET_MS],
  [resolve.owner, RESOLVE_BUDGET_MS],
  [resolve.executableManifest, RESOLVE_BUDGET_MS],
  [resolve.rootManifest, RESOLVE_BUDGET_MS],
  // Boot waits on it, so a protocol frame that does not load or answer must not hold the page for the default budget.
  [wallet.read, 5_000],
]);

/** How long the host waits on `method`, or null for one it waits on without a timer. */
export function budgetOf(method: AnyMethod): number | null {
  const budget = METHOD_TIMEOUTS.get(method);
  return budget === undefined ? DEFAULT_TIMEOUT_MS : budget;
}
