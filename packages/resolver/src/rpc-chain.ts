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
import { getWsProvider } from "polkadot-api/ws";
import type { JsonRpcProvider } from "polkadot-api";
import {
  type ChainService,
  getActiveServicesConfig,
} from "@dotli/config/network";

function getRpcService(genesisHash: string): ChainService | null {
  const cfg = getActiveServicesConfig();
  const key = genesisHash.toLowerCase();
  const services: readonly ChainService[] = [
    cfg.relay,
    cfg.assethub,
    cfg.bulletin,
    cfg.people,
  ];
  return (
    services.find(
      (service) =>
        service.rpcs.length > 0 && service.genesis.toLowerCase() === key,
    ) ?? null
  );
}

export function isRpcChainSupported(genesisHash: string): boolean {
  return getRpcService(genesisHash) !== null;
}

export function createRpcChainProvider(
  genesisHash: string,
): JsonRpcProvider | null {
  const service = getRpcService(genesisHash);
  if (service === null) {
    return null;
  }
  // Public RPC endpoints are occasionally tunnel-gated, so the default 40s
  // heartbeat is too tight. Match the timeout used in `./rpc-resolve.ts`.
  return getWsProvider([...service.rpcs], {
    heartbeatTimeout: 120_000,
  });
}
