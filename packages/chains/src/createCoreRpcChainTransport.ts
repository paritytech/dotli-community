// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Gateway mode's chain providers over trusted public RPC nodes. Never imports smoldot, so the light client
// stays out of any bundle that only pulls this module.
import { withSubscriptionReplay } from '@novasamatech/host-substrate-chain-connection';
import { middleware as compatibilityMiddleware } from '@polkadot-api/ws-middleware';
import type { JsonRpcConnection, JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import type { InnerJsonRpcProvider } from '@polkadot-api/json-rpc-provider-proxy';
import type { JsonRpcProvider } from 'polkadot-api';
import { getWsProvider, WsEvent, type StatusChange } from '@polkadot-api/ws-provider';
import { getActiveCoreGatewayChains, getActiveServicesConfig } from '@dotli/config';
import type { ChainService } from '@dotli/config';
import {
  RPC_FOLLOW_LIMIT,
  type ChainTransport,
  type ChainTransportHooks,
  type ConnectionStatus,
} from './transportHooks.js';

type Params = {
  /** Hears each status change of the chain's socket. */
  hooks?: Pick<ChainTransportHooks, 'onStatus'>;
  /** The socket class the provider's sockets extend, the page's own unless given. */
  WebSocketBase?: typeof WebSocket;
};

type CreateGatewayProviderParams = {
  /** The core gateway chain to reach, or `null` for a chain that is not one, which gets no provider. */
  chain: ChainService | null;
  /** Hears each status change of the chain's socket. */
  hooks: Pick<ChainTransportHooks, 'onStatus'> | undefined;
  /** The socket class the provider's sockets extend. */
  WebSocketBase: typeof WebSocket;
};

const STATUS_BY_WS_EVENT: Record<WsEvent, ConnectionStatus> = {
  [WsEvent.CONNECTING]: 'connecting',
  [WsEvent.CONNECTED]: 'connected',
  [WsEvent.ERROR]: 'disconnected',
  [WsEvent.CLOSE]: 'disconnected',
};

// Some public endpoints sit behind tunnels, which the default 40s heartbeat is too tight for.
const HEARTBEAT_TIMEOUT_MS = 120_000;

const WS_CLOSING = 2;

// One row per lane of a chain, so a lane that closes removes only its own node.
const connectedEndpoints = new Map<string, ReadonlyMap<object, string>>();

/**
 * The chain's transport over its configured RPC nodes, or `null` for a chain that is not a core gateway chain. A
 * reconnect re-sends every confirmed subscription and maps the new ids back to the ones consumers saw.
 */
export function createCoreRpcChainTransport(
  genesisHash: string,
  { hooks, WebSocketBase = globalThis.WebSocket }: Params = {},
): ChainTransport | null {
  const provider = createGatewayProvider({ chain: findCoreGatewayChain(genesisHash), hooks, WebSocketBase });
  return provider === null ? null : { provider, followLimit: RPC_FOLLOW_LIMIT };
}

/** Whether the active network's gateway serves `genesisHash` over RPC nodes. */
export function isCoreRpcChainSupported(genesisHash: string): boolean {
  return findCoreGatewayChain(genesisHash) !== null;
}

/** The RPC node of one connected lane of the chain, or `null` when none is connected. */
export function getConnectedRpcEndpoint(genesisHash: string): string | null {
  const rows = connectedEndpoints.get(genesisHash.toLowerCase());
  return rows === undefined ? null : (rows.values().next().value ?? null);
}

/** The node of one connected Asset Hub lane, which may not be the first configured one, since the transport rotates, or `null` when none is connected. */
export function getConnectedAssetHubRpcEndpoint(): string | null {
  return getConnectedRpcEndpoint(getActiveServicesConfig().assethub.genesis);
}

function createGatewayProvider({ chain, hooks, WebSocketBase }: CreateGatewayProviderParams): JsonRpcProvider | null {
  if (chain === null) {
    return null;
  }
  let replay: () => void = () => undefined;
  const { WebSocketClass, closeLatest } = createClosingWebSocketClass(WebSocketBase);
  const owner = {};
  const genesisKey = chain.genesis.toLowerCase();
  function clearEndpoint(): void {
    const rows = connectedEndpoints.get(genesisKey);
    if (rows === undefined) {
      return;
    }
    if (!rows.has(owner)) {
      return;
    }
    const rest = new Map(rows);
    rest.delete(owner);
    if (rest.size === 0) {
      connectedEndpoints.delete(genesisKey);
    } else {
      connectedEndpoints.set(genesisKey, rest);
    }
  }
  function recordEndpoint(event: StatusChange): void {
    switch (event.type) {
      case WsEvent.CONNECTING:
      case WsEvent.CONNECTED:
        connectedEndpoints.set(genesisKey, new Map(connectedEndpoints.get(genesisKey)).set(owner, event.uri));
        return;
      case WsEvent.ERROR:
      case WsEvent.CLOSE:
        clearEndpoint();
        return;
    }
  }
  function applyStatus(status: ConnectionStatus): void {
    switch (status) {
      case 'connecting':
        return;
      case 'connected':
        replay();
        return;
      case 'disconnected':
        closeLatest();
        return;
    }
  }
  const socket = getWsProvider([...chain.rpcs], {
    heartbeatTimeout: HEARTBEAT_TIMEOUT_MS,
    websocketClass: WebSocketClass,
    middleware: inner => withOwnMessages(compatibilityMiddleware(inner)),
    onStatusChanged: event => {
      recordEndpoint(event);
      const status = STATUS_BY_WS_EVENT[event.type];
      applyStatus(status);
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
  function provider(onMessage: (message: JsonRpcMessage) => void): JsonRpcConnection {
    const connection = replaying(onMessage);
    return {
      send: message => {
        connection.send(message);
      },
      disconnect() {
        connection.disconnect();
        clearEndpoint();
      },
    };
  }
  return provider;
}

/**
 * ws-provider replaces a socket it counts as dead but never closes it, so it stays open and keeps receiving.
 * Call `closeLatest` on `disconnected`. Assumes one live connection per provider.
 */
function createClosingWebSocketClass(Base: typeof WebSocket): {
  WebSocketClass: typeof WebSocket;
  closeLatest: () => void;
} {
  let latest: WebSocket | null = null;
  function closeLatest(): void {
    if (latest !== null && latest.readyState < WS_CLOSING) {
      latest.close();
    }
  }
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
  function connectWithOwnMessages(
    onMessage: (message: JsonRpcMessage) => void,
    onHalt: (error?: unknown) => void,
  ): JsonRpcConnection {
    const connection = inner(onMessage, onHalt);
    return {
      send: message => {
        connection.send({ ...message });
      },
      disconnect: () => {
        connection.disconnect();
      },
    };
  }
  return connectWithOwnMessages;
}

function findCoreGatewayChain(genesisHash: string): ChainService | null {
  const key = genesisHash.toLowerCase();
  return getActiveCoreGatewayChains().find(chain => chain.genesis.toLowerCase() === key) ?? null;
}
