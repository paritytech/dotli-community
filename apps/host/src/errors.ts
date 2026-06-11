// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  ProtocolFatalError,
  ProtocolInitFailedError,
} from "@dotli/protocol/errors";

export const HOST_ERRORS = {
  FATAL_PANIC: "The light client (smoldot) crashed unexpectedly.",
  SW_FAILED_TO_START: "The light client failed to start on the shared worker.",
  SW_SYNC_TIMEOUT:
    "The light client couldn't sync in time on the shared worker.",
  SW_TIMED_OUT: "The light client timed out during startup.",
  AH_SYNC_TIMEOUT:
    "Light client timed out syncing to Asset Hub - no connection with peers.",
  LIGHT_CLIENT_TIMEOUT: "Light client timed out - no connection with peers.",
  RPC_TIMEOUT: "The RPC endpoint didn't respond in time.",
  MODULE_FETCH_FAILED: "Couldn't load app resources — reload to retry.",
  CHAIN_SPEC_REJECTED:
    "The light client couldn't load the chain configuration.",
  CONTENTHASH_UNSUPPORTED: "This domain's content format isn't supported.",
} as const;

export const FAILOVER_BTN_LABELS = {
  "rpc-gateway": "Use Trusted Provider",
  "smoldot-shared-worker": "Try Light Client Shared",
} as const;

export const REFRESH_BTN_LABEL = "Refresh";

export type Recovery = "switch-backend" | "reload" | "none";

export interface ErrorDescription {
  message: string;
  recovery: Recovery;
}

/**
 * Map an arbitrary error thrown during resolution to a user-facing message
 * and a recovery hint. `isP2p` toggles copy that would be wrong in the
 * other mode (e.g. calling a dead RPC "light client").
 */
export function describeError(err: unknown, isP2p: boolean): ErrorDescription {
  const msg = err instanceof Error ? err.message : String(err);

  if (err instanceof ProtocolFatalError) {
    return { message: HOST_ERRORS.FATAL_PANIC, recovery: "switch-backend" };
  }
  // Specific message matches run before the generic init-failed fallback so
  // a more descriptive message (e.g. "chain spec rejected") isn't masked by
  // the broad `ProtocolInitFailedError` branch.
  if (msg.includes("chain spec") || msg.includes("Chain spec")) {
    return {
      message: HOST_ERRORS.CHAIN_SPEC_REJECTED,
      recovery: "switch-backend",
    };
  }
  if (msg.includes("Failed to fetch dynamically imported module")) {
    return { message: HOST_ERRORS.MODULE_FETCH_FAILED, recovery: "reload" };
  }
  if (
    msg.includes("non-IPFS contenthash") ||
    msg.includes("Failed to decode contenthash")
  ) {
    return { message: HOST_ERRORS.CONTENTHASH_UNSUPPORTED, recovery: "none" };
  }
  if (msg.includes("did not signal ready")) {
    return { message: HOST_ERRORS.SW_TIMED_OUT, recovery: "switch-backend" };
  }
  // Pre-sync deadline: the worker *did* boot, it just couldn't sync in time.
  // Distinct from a SharedWorker that never started at all.
  if (msg.includes("did not complete")) {
    return {
      message: HOST_ERRORS.SW_SYNC_TIMEOUT,
      recovery: "switch-backend",
    };
  }
  if (msg.includes("Asset Hub") && msg.includes("timed out")) {
    return { message: HOST_ERRORS.AH_SYNC_TIMEOUT, recovery: "switch-backend" };
  }
  if (err instanceof ProtocolInitFailedError) {
    return {
      message: HOST_ERRORS.SW_FAILED_TO_START,
      recovery: "switch-backend",
    };
  }
  if (msg.includes("timed out") || msg.includes("Timed out")) {
    return {
      message: isP2p
        ? HOST_ERRORS.LIGHT_CLIENT_TIMEOUT
        : HOST_ERRORS.RPC_TIMEOUT,
      recovery: "switch-backend",
    };
  }
  return { message: msg, recovery: "switch-backend" };
}
