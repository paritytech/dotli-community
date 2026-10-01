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
import { getWsProvider } from '@polkadot-api/ws-provider';
import { middleware as substrateCompatibility } from '@polkadot-api/ws-middleware';
import type { JsonRpcProvider } from 'polkadot-api';
import type { JsonRpcConnection } from '@polkadot-api/json-rpc-provider';
import { getActiveCoreGatewayChains, getActiveGatewayChains } from '@dotli/config';
import type { ChainService } from '@dotli/config';

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

/** Gateway provider whose owner must interrupt its consumers when `onHalt` fires. */
export function createRpcChainProvider(genesisHash: string, onHalt: () => void): JsonRpcProvider | null {
  return createGatewayProvider(gatewayChain(genesisHash), onHalt);
}

/** Whether the host-owned Rust core can reach `genesisHash` in gateway mode. */
export function isCoreRpcChainSupported(genesisHash: string): boolean {
  return coreGatewayChain(genesisHash) !== null;
}

/** Gateway provider for host-owned Rust-core traffic, including Bulletin. */
export function createCoreRpcChainProvider(genesisHash: string, onHalt: () => void): JsonRpcProvider | null {
  return createGatewayProvider(coreGatewayChain(genesisHash), onHalt);
}

function createGatewayProvider(chain: ChainService | null, onHalt: () => void): JsonRpcProvider | null {
  if (chain === null) {
    return null;
  }
  return onMessage => {
    const state: { socket: WebSocket | null; connected: boolean; closed: boolean } = {
      socket: null,
      connected: false,
      closed: false,
    };
    let connection: JsonRpcConnection | null = null;
    const healthRequest = {
      jsonrpc: '2.0' as const,
      id: `dotli-health:${crypto.randomUUID()}`,
      method: 'system_health',
      params: [],
    };
    const closeSocket = (): void => {
      if (state.socket !== null && state.socket.readyState < WebSocket.CLOSING) {
        state.socket.close();
      }
      state.socket = null;
    };
    const disconnect = (): void => {
      if (state.closed) {
        return;
      }
      state.closed = true;
      connection?.disconnect();
      closeSocket();
    };
    // ws-provider detaches listeners on a heartbeat timeout without closing
    // the socket. Retain ownership so a failed transport cannot leak it.
    class GatewaySocket extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        state.socket = this;
        this.addEventListener(
          'open',
          () => {
            state.connected = true;
          },
          { once: true },
        );
      }
    }
    const provider = getWsProvider([...chain.rpcs], {
      heartbeatTimeout: 120_000,
      websocketClass: GatewaySocket,
      // polkadot-api/ws installs this middleware unconditionally, so compose
      // its compatibility layer explicitly around our raw transport lifecycle.
      middleware: base =>
        substrateCompatibility((deliver, retryConnection) => {
          let healthTimer: ReturnType<typeof setTimeout> | undefined;
          const stopHealth = (): void => {
            clearTimeout(healthTimer);
            healthTimer = undefined;
          };
          const scheduleHealth = (): void => {
            stopHealth();
            healthTimer = setTimeout(() => {
              // Silence is normal for subscriptions. A reply (including an RPC
              // error) proves liveness; no reply leaves the 120s deadline intact.
              transport.send(healthRequest);
            }, 60_000);
          };
          const transport = base(
            message => {
              scheduleHealth();
              if (!('id' in message) || message.id !== healthRequest.id) {
                deliver(message);
              }
            },
            () => {
              stopHealth();
              closeSocket();
              if (!state.connected) {
                // Keep endpoint failover while establishing the first connection.
                retryConnection();
                return;
              }
              // The proxy only recovers some subscription families. Never let it
              // replace an established raw RPC session behind its owner's back.
              disconnect();
              onHalt();
            },
          );
          scheduleHealth();
          return {
            send: message => {
              transport.send(message);
            },
            disconnect: () => {
              stopHealth();
              transport.disconnect();
            },
          };
        }),
    });
    const active = provider(onMessage);
    connection = active;
    if (state.closed) {
      active.disconnect();
    }
    return {
      send: message => {
        if (state.closed) {
          throw new Error('RPC chain connection is closed');
        }
        active.send(message);
      },
      disconnect,
    };
  };
}
