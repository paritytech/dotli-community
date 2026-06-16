// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Timeouts (ms)
export const TIMEOUTS = {
  /** SW cache lookup before falling through */
  SW_CACHE_LOOKUP: 3_000,
  /** Host recover-request grace before the sandbox falls back to the
   * contract error. Must exceed the host's recover rate-limit window so
   * a rate-limited request fails visibly instead of hanging. */
  SANDBOX_RECOVER: 6_000,
  /** Waiting for SW controllerchange after registration */
  SW_READY: 10_000,
  /** P2P fetch abort (per attempt) */
  P2P_FETCH: 30_000,
  /** SharedWorker readiness timeout. Must exceed `ASSET_HUB_FINALIZED_SYNC`
   * so the outer wait doesn't race the inner sync timeout. */
  SHARED_WORKER_READY: 210_000,
  /** Upper bound on `getFinalizedBlock()` while bootstrapping smoldot. */
  ASSET_HUB_FINALIZED_SYNC: 180_000,
  /** Upper bound on the background People-chain warm for legacy-account auth. */
  PEOPLE_FINALIZED_SYNC: 180_000,
} as const;
