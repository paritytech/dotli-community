// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Gateway mode's chain providers over trusted public RPC nodes. Never imports smoldot, so the light client
// stays out of any bundle that only pulls this module.
import { withSubscriptionReplay } from '@novasamatech/host-substrate-chain-connection';
import { middleware as compatibilityMiddleware } from '@polkadot-api/ws-middleware';
import type { InnerJsonRpcProvider } from '@polkadot-api/json-rpc-provider-proxy';
import type { JsonRpcProvider } from 'polkadot-api';
import { getWsProvider, WsEvent } from '@polkadot-api/ws-provider';
import { getActiveCoreGatewayChains } from '@dotli/config';
import type { ChainService } from '@dotli/config';
import { createPauseController } from './pause-controller.js';
import type { ChainTransportHooks, ConnectionStatus } from './transport-hooks.js';

/** A reconnect re-sends every confirmed subscription and maps the new ids back to the ones consumers saw. */
export type RpcChainProvider = JsonRpcProvider & { pause: () => void; resume: () => void };

const STATUS_BY_WS_EVENT: Record<WsEvent, ConnectionStatus> = {
  [WsEvent.CONNECTING]: 'connecting',
  [WsEvent.CONNECTED]: 'connected',
  [WsEvent.ERROR]: 'disconnected',
  [WsEvent.CLOSE]: 'disconnected',
};

// Some public endpoints sit behind tunnels, which the default 40s heartbeat is too tight for.
const HEARTBEAT_TIMEOUT_MS = 120_000;

const WS_CLOSING = 2;

/**
 * ws-provider replaces a socket it counts as dead but never closes it, so it stays open and keeps receiving.
 * Call `closeLatest` on `disconnected`. Assumes one live connection per provider.
 */
function closingWebSocketClass(): { WebSocketClass: typeof WebSocket; closeLatest: () => void } {
  const Base = globalThis.WebSocket;
  let latest: WebSocket | null = null;
  const closeLatest = (): void => {
    if (latest !== null && latest.readyState < WS_CLOSING) {
      latest.close();
    }
  };
  const WebSocketClass = class ClosingWebSocket extends Base {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      closeLatest();
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- the next socket this provider builds closes this one.
      latest = this;
    }
  };
  return { WebSocketClass, closeLatest };
}

/**
 * `@polkadot-api/ws-middleware` 0.4.2 rewrites `id` on the caller's object, and the replay resends those
 * objects after a reconnect. Delete once numeric-ids sends a copy.
 */
function withOwnMessages(inner: InnerJsonRpcProvider): InnerJsonRpcProvider {
  return (onMessage, onHalt) => {
    const connection = inner(onMessage, onHalt);
    return {
      send: message => {
        connection.send({ ...message });
      },
      disconnect: () => {
        connection.disconnect();
      },
    };
  };
}

function coreGatewayChain(genesisHash: string): ChainService | null {
  const key = genesisHash.toLowerCase();
  return getActiveCoreGatewayChains().find(chain => chain.genesis.toLowerCase() === key) ?? null;
}

export function isCoreRpcChainSupported(genesisHash: string): boolean {
  return coreGatewayChain(genesisHash) !== null;
}

export function createCoreRpcChainProvider(
  genesisHash: string,
  hooks?: Pick<ChainTransportHooks, 'onStatus'>,
): RpcChainProvider | null {
  return createGatewayProvider(coreGatewayChain(genesisHash), hooks);
}

const connectedEndpoints = new Map<string, { uri: string; owner: object }>();

/** `null` between sockets. */
export function getConnectedRpcEndpoint(genesisHash: string): string | null {
  return connectedEndpoints.get(genesisHash.toLowerCase())?.uri ?? null;
}

function createGatewayProvider(
  chain: ChainService | null,
  hooks: Pick<ChainTransportHooks, 'onStatus'> | undefined,
): RpcChainProvider | null {
  if (chain === null) {
    return null;
  }
  let replay: () => void = () => undefined;
  const pauseController = createPauseController();
  const { WebSocketClass, closeLatest } = closingWebSocketClass();
  const owner = {};
  const genesisKey = chain.genesis.toLowerCase();
  // Only the provider that recorded the endpoint may clear it.
  const clearEndpoint = (): void => {
    if (connectedEndpoints.get(genesisKey)?.owner === owner) {
      connectedEndpoints.delete(genesisKey);
    }
  };
  const socket = getWsProvider([...chain.rpcs], {
    heartbeatTimeout: HEARTBEAT_TIMEOUT_MS,
    websocketClass: WebSocketClass,
    // Below the pause controller, so the compatibility probe starts over with each socket.
    middleware: inner => pauseController.middleware(withOwnMessages(compatibilityMiddleware(inner))),
    onStatusChanged: event => {
      // Only CONNECTING and CONNECTED carry the endpoint.
      if ('uri' in event) {
        connectedEndpoints.set(genesisKey, { uri: event.uri, owner });
      } else {
        clearEndpoint();
      }
      const status = STATUS_BY_WS_EVENT[event.type];
      if (status === 'connected') {
        replay();
      }
      if (status === 'disconnected') {
        closeLatest();
      }
      hooks?.onStatus(status);
    },
  });
  const replaying = withSubscriptionReplay(socket, callback => {
    replay = callback;
    return () => {
      replay = () => undefined;
    };
  });
  // ws-provider emits no status event for a disconnect, so clear the endpoint here.
  const provider: JsonRpcProvider = onMessage => {
    const connection = replaying(onMessage);
    return {
      send: message => {
        connection.send(message);
      },
      disconnect: () => {
        connection.disconnect();
        clearEndpoint();
      },
    };
  };
  return Object.assign(provider, { pause: pauseController.pause, resume: pauseController.resume });
}
