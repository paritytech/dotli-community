// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Milliseconds. */
export const TIMEOUTS = {
  /**
   * Wait for a host recover reply. Exceeds the host's recover rate-limit window, so a limited request fails visibly.
   */
  SANDBOX_RECOVER: 6_000,
  /** Wait for `controllerchange` after registration. */
  SW_READY: 10_000,
  /** Persisting a maximum-size application archive in the service worker. */
  SW_ARCHIVE_STORE: 180_000,
  /** P2P fetch abort (per attempt) */
  P2P_FETCH: 30_000,
  /**
   * Exceeds `HUB_FINALIZED_SYNC` so the outer wait doesn't race the inner one. A caller with its own deadline
   * reserves `RESPONSE_DELIVERY_GRACE` instead.
   */
  SHARED_WORKER_READY: 210_000,
  /** Upper bound on `getFinalizedBlock()` while bootstrapping smoldot. */
  HUB_FINALIZED_SYNC: 180_000,
  /** Upper bound on the background People-chain warm for legacy-account auth. */
  PEOPLE_FINALIZED_SYNC: 180_000,
  /**
   * Held back from a caller's deadline so the typed resolver error crosses postMessage before the caller's timer fires.
   */
  RESPONSE_DELIVERY_GRACE: 1_000,
} as const;
