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
 * Coverage is the active network's relay, Asset Hub, People, and Bulletin
 * chains when they have configured `rpcs`. Login and identity resolution live
 * on the People chain, so it must be reachable for auth to work in gateway
 * mode. Bulletin is reachable so in-core preimage submission can use its
 * `TransactionStorage` runtime API over the same trusted RPC posture.
 */
import { getWsProvider } from "polkadot-api/ws";
import type { JsonRpcProvider } from "polkadot-api";
import { getActiveCoreGatewayChains } from "@dotli/config/network";
import type { ChainService } from "@dotli/config/network";

function upstreamGatewayChain(genesisHash: string): ChainService | null {
  const key = genesisHash.toLowerCase();
  return (
    getActiveCoreGatewayChains().find(
      (chain) => chain.genesis.toLowerCase() === key,
    ) ?? null
  );
}

/** Whether the protocol runtime can connect to `genesisHash` in gateway mode. */
export function isRpcUpstreamSupported(genesisHash: string): boolean {
  return upstreamGatewayChain(genesisHash) !== null;
}

/** A WSS upstream provider for an operational gateway chain. */
export function createRpcUpstreamProvider(
  genesisHash: string,
): JsonRpcProvider | null {
  return createGatewayProvider(upstreamGatewayChain(genesisHash));
}

function createGatewayProvider(
  chain: ChainService | null,
): JsonRpcProvider | null {
  if (chain === null) {
    return null;
  }
  // Public RPC endpoints are occasionally tunnel-gated, so the default 40s
  // heartbeat is too tight. Match the timeout used in `./rpc-resolve.ts`.
  return getWsProvider([...chain.rpcs], {
    heartbeatTimeout: 120_000,
  });
}
