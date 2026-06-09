// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li WSS JSON-RPC chain provider (gateway mode).
//
// Produces a `JsonRpcProvider` backed by a public Polkadot RPC node instead
// of smoldot. Used by the protocol host iframe when running in `rpc` submode
// so sandboxed apps can issue chain calls via `chainConnect` without
// requiring a light client.
//
// Trust model: the RPC endpoints are trusted. This is the same trade-off
// gateway-mode name resolution already makes in `./rpc-resolve.ts`.
//
// Intentionally does not import smoldot so Vite can tree-shake the worker
// out of any bundle that only pulls this module.
//
// Currently only Asset Hub Paseo has curated RPC endpoints in
// `@dotli/config`. Other supported chains (relay, Bulletin) fall back to
// `null`, meaning sandboxed apps will see an immediate "chain unsupported"
// error instead of silently hanging. Add more endpoints to config to widen
// coverage.
import { getWsProvider } from "polkadot-api/ws";
import type { JsonRpcProvider } from "polkadot-api";
import { getActiveServicesConfig } from "@dotli/config/network";

export function isRpcChainSupported(genesisHash: string): boolean {
  return (
    genesisHash.toLowerCase() ===
    getActiveServicesConfig().assethub.genesis.toLowerCase()
  );
}

export function createRpcChainProvider(
  genesisHash: string,
): JsonRpcProvider | null {
  const assethub = getActiveServicesConfig().assethub;
  if (genesisHash.toLowerCase() === assethub.genesis.toLowerCase()) {
    // Single active endpoint, no silent round-robin.
    // Public RPC endpoints are occasionally tunnel-gated, so the default 40s
    // heartbeat is too tight. Match the timeout used in `./rpc-resolve.ts`.
    return getWsProvider([...assethub.rpcs], {
      heartbeatTimeout: 120_000,
    });
  }
  return null;
}
