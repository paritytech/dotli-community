// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WSS JSON-RPC chain providers for gateway mode.
 *
 * Produces a `JsonRpcProvider` backed by a public Polkadot RPC node instead
 * of smoldot. The protocol host iframe uses these in `rpc` submode so
 * sandboxed apps can issue chain calls via `chainConnect` without a light
 * client. The endpoints are trusted, the same posture `./rpc-resolve.ts`
 * already takes for gateway-mode name resolution.
 *
 * smoldot is never imported here, so Vite tree-shakes the light client out of
 * any bundle that only pulls this module.
 *
 * Coverage is the active network's relay, Asset Hub, and People chains, each
 * dialled through its configured `rpcs`. Login and identity resolution live
 * on the People chain, so it must be reachable for auth to work in gateway
 * mode. Bulletin is deliberately absent. Its content (IPFS or bitswap) is
 * served through IPFS gateways, not a chain RPC connection.
 */
import { getWsProvider } from "polkadot-api/ws";
import type { JsonRpcProvider } from "polkadot-api";
import { getActiveServicesConfig } from "@dotli/config/network";
import type { ChainService } from "@dotli/config/network";

/** Resolve a genesis hash to its active-network chain, or `null` when gateway mode cannot reach it. */
function gatewayChain(genesisHash: string): ChainService | null {
  const cfg = getActiveServicesConfig();
  const key = genesisHash.toLowerCase();
  const chain = [cfg.relay, cfg.assethub, cfg.people].find(
    (c) => c.genesis.toLowerCase() === key,
  );
  if (chain === undefined || chain.rpcs.length === 0) {
    return null;
  }
  return chain;
}

/** Whether gateway mode can serve chain calls for `genesisHash`. */
export function isRpcChainSupported(genesisHash: string): boolean {
  return gatewayChain(genesisHash) !== null;
}

/** A WSS JSON-RPC provider for `genesisHash`, or `null` when gateway mode does not support that chain. */
export function createRpcChainProvider(
  genesisHash: string,
): JsonRpcProvider | null {
  const chain = gatewayChain(genesisHash);
  if (chain === null) {
    return null;
  }
  // Public RPC endpoints are occasionally tunnel-gated, so the default 40s
  // heartbeat is too tight. Match the timeout used in `./rpc-resolve.ts`.
  return getWsProvider([...chain.rpcs], {
    heartbeatTimeout: 120_000,
  });
}
