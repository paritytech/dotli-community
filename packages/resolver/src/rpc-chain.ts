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
 *
 * Each provider is the replaying, pausable ws provider from
 * `@novasamatech/host-substrate-chain-connection`, the one polkadot-desktop
 * runs: a socket the heartbeat replaces comes back with its subscriptions.
 */
import { createWsJsonRpcProvider } from '@novasamatech/host-substrate-chain-connection';
import { getActiveCoreGatewayChains, getActiveGatewayChains } from '@dotli/config';
import type { ChainService } from '@dotli/config';
import type { ChainTransportHooks } from './transport-hooks.js';

/**
 * A chain's WebSocket transport: polkadot-api's ws provider with
 * `withSubscriptionReplay` on top, which re-sends every confirmed
 * subscription when the socket reconnects and maps the server's new
 * subscription id back to the one its consumer saw. It can be paused (the
 * socket closes, sends buffer) and resumed.
 */
export type RpcChainProvider = ReturnType<typeof createWsJsonRpcProvider>;

// Public RPC endpoints are occasionally tunnel-gated, so the default 40s
// heartbeat is too tight. Match the timeout used in `./rpc-resolve.ts`.
const HEARTBEAT_TIMEOUT_MS = 120_000;

const WS_CLOSING = 2;

/**
 * A WebSocket class whose every new instance closes the one before it.
 *
 * ws-provider counts a socket silent for `heartbeatTimeout` as dead: it drops
 * the socket's listeners and opens a new one, but never closes the old one,
 * which stays open and keeps receiving. The provider builds its sockets one
 * at a time, so the previous socket is always the abandoned one. Read from
 * `globalThis` per provider, so a test's stub applies.
 */
function closingWebSocketClass(): typeof WebSocket {
  const Base = globalThis.WebSocket;
  let previous: WebSocket | null = null;
  return class ClosingWebSocket extends Base {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      if (previous !== null && previous.readyState < WS_CLOSING) {
        previous.close();
      }
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- the next socket this provider builds closes this one.
      previous = this;
    }
  };
}

/**
 * Resolve a genesis hash to its active-network chain, or `null` when gateway
 * mode cannot reach it. Backed by `getActiveGatewayChains()` so the set of
 * gateway-served chains stays identical to what the host advertises via
 * `isRemoteChainSupported`.
 */
function gatewayChain(genesisHash: string): ChainService | null {
  const key = genesisHash.toLowerCase();
  return getActiveGatewayChains().find(c => c.genesis.toLowerCase() === key) ?? null;
}

function coreGatewayChain(genesisHash: string): ChainService | null {
  const key = genesisHash.toLowerCase();
  return getActiveCoreGatewayChains().find(chain => chain.genesis.toLowerCase() === key) ?? null;
}

/** Whether gateway mode can serve chain calls for `genesisHash`. */
export function isRpcChainSupported(genesisHash: string): boolean {
  return gatewayChain(genesisHash) !== null;
}

/** A WSS JSON-RPC provider for `genesisHash`, or `null` when gateway mode does not support that chain. */
export function createRpcChainProvider(
  genesisHash: string,
  hooks?: Pick<ChainTransportHooks, 'onStatus'>,
): RpcChainProvider | null {
  return createGatewayProvider(gatewayChain(genesisHash), hooks);
}

/** Whether the host-owned Rust core can reach `genesisHash` in gateway mode. */
export function isCoreRpcChainSupported(genesisHash: string): boolean {
  return coreGatewayChain(genesisHash) !== null;
}

/** Gateway provider for host-owned Rust-core traffic, including Bulletin. */
export function createCoreRpcChainProvider(
  genesisHash: string,
  hooks?: Pick<ChainTransportHooks, 'onStatus'>,
): RpcChainProvider | null {
  return createGatewayProvider(coreGatewayChain(genesisHash), hooks);
}

function createGatewayProvider(
  chain: ChainService | null,
  hooks: Pick<ChainTransportHooks, 'onStatus'> | undefined,
): RpcChainProvider | null {
  if (chain === null) {
    return null;
  }
  return createWsJsonRpcProvider({
    endpoints: [...chain.rpcs],
    heartbeatTimeout: HEARTBEAT_TIMEOUT_MS,
    websocketClass: closingWebSocketClass(),
    ...(hooks !== undefined && { onStatusChanged: hooks.onStatus }),
  });
}
