// dot.li — TEMPORARY trusted-RPC route for the vox.paseo presence snapshot
//
// Smoldot has no retained Statement Store snapshot: it completes a new
// subscription with an empty batch and only relays later gossip. Vox presence
// notes last three minutes, so a newly opened device otherwise cannot list a
// device that posted before it subscribed.
//
// This route recognizes only the exact MatchAll filter for
// blake2b-256("vox.paseo/lobby/v1"). Other product topics and broader filters
// stay on the light client. The trusted node learns when somebody reads the
// public Vox lobby topic and can omit notes, but it cannot forge a valid note.
// Remove this route once the light client can retrieve retained statements.

import type { JsonRpcConnection, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { createChainPool, type ChainPool } from '@dotli/protocol';
import { createCoreRpcChainProvider } from '@dotli/resolver';
import { log } from '@dotli/shared';

/** blake2b-256("vox.paseo/lobby/v1"), derived by the Vox product. */
export const VOX_PASEO_LOBBY_TOPIC = '0x5ed77c17f1588a282b87eeaf44c116e501e9206038121f5804aec08dd1e7fe24';

type RpcId = string | number;
type SubscriptionId = string | number;

const trustedPresencePool = createChainPool({
  createTransport: createCoreRpcChainProvider,
  destroyDelay: 0,
});

let announced = false;

function rpcId(value: unknown): RpcId | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

function isVoxPresenceSubscribe(request: JsonRpcRequest<unknown>): boolean {
  const params: unknown = request.params;
  if (request.method !== 'statement_subscribeStatement' || !Array.isArray(params) || params.length !== 1) {
    return false;
  }
  const filter: unknown = params[0];
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
    return false;
  }
  if (!('matchAll' in filter) || Reflect.ownKeys(filter).length !== 1) {
    return false;
  }
  const topics: unknown = filter.matchAll;
  return Array.isArray(topics) && topics.length === 1 && String(topics[0]).toLowerCase() === VOX_PASEO_LOBBY_TOPIC;
}

function unsubscribeTarget(request: JsonRpcRequest<unknown>): SubscriptionId | null {
  const params: unknown = request.params;
  if (request.method !== 'statement_unsubscribeStatement' || !Array.isArray(params) || params.length !== 1) {
    return null;
  }
  return rpcId(params[0]);
}

export interface VoxPresenceSnapshotRoute {
  /** Send an exact Vox presence subscription lifecycle to the trusted node; whether this route owns it. */
  send: (request: JsonRpcRequest<unknown>) => boolean;
  close: () => void;
}

export function createVoxPresenceSnapshotRoute(
  genesisHash: string,
  deliver: (message: unknown) => void,
  pool: ChainPool = trustedPresencePool,
): VoxPresenceSnapshotRoute {
  let lease: JsonRpcConnection | null = null;
  let closed = false;
  const pendingSubscribes = new Set<RpcId>();
  const pendingUnsubscribes = new Map<RpcId, SubscriptionId>();
  const subscriptions = new Set<SubscriptionId>();

  const receive = (message: unknown): void => {
    const response =
      typeof message === 'object' && message !== null && !Array.isArray(message)
        ? (message as { id?: unknown; result?: unknown })
        : null;
    const id = rpcId(response?.id);
    if (id !== null && pendingSubscribes.delete(id)) {
      const subscription = rpcId(response?.result);
      if (subscription !== null) {
        subscriptions.add(subscription);
      }
    }
    if (id !== null) {
      const subscription = pendingUnsubscribes.get(id);
      if (subscription !== undefined) {
        pendingUnsubscribes.delete(id);
        subscriptions.delete(subscription);
      }
    }
    deliver(message);
  };

  const open = (): JsonRpcConnection | null => {
    if (lease !== null) {
      return lease;
    }
    const provider = pool.getLocalProvider(genesisHash);
    if (provider === null) {
      log.warn(
        `[dot.li] TEMPORARY: no trusted RPC node for ${genesisHash}; the Vox presence snapshot stays on the light client, which returns no stored statements.`,
      );
      return null;
    }
    if (!announced) {
      announced = true;
      log.warn(
        '[dot.li] TEMPORARY: the vox.paseo presence snapshot uses the trusted People RPC node; the light client returns no stored statements.',
      );
    }
    const slot = { connection: null as JsonRpcConnection | null, halted: false };
    const connection = provider(receive, () => {
      slot.halted = true;
      if (lease === slot.connection) {
        lease = null;
        pendingSubscribes.clear();
        pendingUnsubscribes.clear();
        subscriptions.clear();
      }
    });
    if (slot.halted) {
      return null;
    }
    slot.connection = lease = connection;
    return connection;
  };

  return {
    send(request) {
      if (closed) {
        return false;
      }
      const id = rpcId(request.id);
      if (id !== null && isVoxPresenceSubscribe(request)) {
        const connection = open();
        if (connection === null) {
          return false;
        }
        pendingSubscribes.add(id);
        try {
          connection.send(request);
        } catch (error) {
          pendingSubscribes.delete(id);
          throw error;
        }
        return true;
      }

      const subscription = unsubscribeTarget(request);
      if (subscription === null || !subscriptions.has(subscription)) {
        return false;
      }
      const connection = open();
      if (connection === null) {
        return false;
      }
      if (id !== null) {
        pendingUnsubscribes.set(id, subscription);
      } else {
        subscriptions.delete(subscription);
      }
      try {
        connection.send(request);
      } catch (error) {
        if (id !== null) {
          pendingUnsubscribes.delete(id);
        }
        throw error;
      }
      return true;
    },
    close() {
      closed = true;
      pendingSubscribes.clear();
      pendingUnsubscribes.clear();
      subscriptions.clear();
      lease?.disconnect();
      lease = null;
    },
  };
}
