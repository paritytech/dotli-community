// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Backend } from "@dotli/config/mode";

const VALID_BACKENDS: ReadonlySet<string> = new Set<Backend>([
  "smoldot-direct",
  "smoldot-shared-worker",
  "rpc-gateway",
]);

function readChainBackend(): Backend {
  const backend = process.env.E2E_CHAIN_BACKEND ?? "rpc-gateway";
  if (!VALID_BACKENDS.has(backend)) {
    throw new Error(
      `E2E_CHAIN_BACKEND must be smoldot-direct, smoldot-shared-worker, or rpc-gateway; got ${JSON.stringify(backend)}`,
    );
  }
  return backend as Backend;
}

export const E2E_CHAIN_BACKEND = readChainBackend();

/** Set the canonical backend key before any host script reads it. */
export function initializeChainBackend(backend: Backend): void {
  try {
    localStorage.setItem("dotli:chain-backend", backend);
    localStorage.removeItem("dotli:mode");
    localStorage.removeItem("dotli:content-backend");
  } catch (error) {
    if (window === window.top) {
      throw error;
    }
  }
}
