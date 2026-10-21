// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Milliseconds. Only budgets more than one package keeps in step. */
export const TIMEOUTS = {
  /**
   * Exceeds `HUB_FINALIZED_SYNC` so the outer wait doesn't race the inner one. A caller with its own deadline
   * reserves `RESPONSE_DELIVERY_GRACE` instead.
   */
  SHARED_WORKER_READY: 210_000,
  /** Upper bound on `getFinalizedBlock()` while bootstrapping smoldot. */
  HUB_FINALIZED_SYNC: 180_000,
  /**
   * Held back from a caller's deadline so the typed resolver error crosses postMessage before the caller's timer fires.
   */
  RESPONSE_DELIVERY_GRACE: 1_000,
  /** Whole budget of one block fetch in the bitswap client. A waiter on the relay reserves the grace on top. */
  BITSWAP_TOTAL_BUDGET: 180_000,
} as const;
