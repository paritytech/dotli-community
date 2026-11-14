// dot.li — TEMPORARY trusted-RPC route for the vox.paseo presence snapshot
//
// Smoldot completes a new Statement Store subscription with an empty batch.
// Vox presence notes last three minutes, so a newly opened device otherwise
// cannot list a device that posted before it subscribed. A light-client
// submit can also land on a different node than another device's trusted
// subscription, so the exact Vox lobby submissions follow it to that node.
//
// This route recognizes only the exact MatchAll filter and statements carrying
// exactly one Topic field equal to blake2b-256("vox.paseo/lobby/v1"). Other
// product topics, broader filters and unrelated submissions stay on the light
// client. The trusted node learns when somebody reads or posts to the public
// Vox lobby topic and can omit notes, but it cannot forge a valid note.
// Remove this route once the light client can retrieve retained statements.

import { scale, StatementProof } from '@parity/truapi';
import type { JsonRpcConnection, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { createChainPool, type ChainPool } from '@dotli/protocol';
import { createCoreRpcChainProvider } from '@dotli/resolver';
import { log } from '@dotli/shared';

/** blake2b-256("vox.paseo/lobby/v1"), derived by the Vox product. */
export const VOX_PASEO_LOBBY_TOPIC = '0x5ed77c17f1588a282b87eeaf44c116e501e9206038121f5804aec08dd1e7fe24';
const StatementField = scale.TaggedUnion({
  Proof: StatementProof,
  DecryptionKey: scale.Hex(32),
  Expiry: scale.u64,
  Channel: scale.Hex(32),
  Topic1: scale.Hex(32),
  Topic2: scale.Hex(32),
  Topic3: scale.Hex(32),
  Topic4: scale.Hex(32),
  Data: scale.Hex(),
});
const StatementFields = scale.Vector(StatementField);

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
function isVoxPresenceSubmit(request: JsonRpcRequest<unknown>): boolean {
  const params: unknown = request.params;
  if (request.method !== 'statement_submit' || !Array.isArray(params) || params.length !== 1) {
    return false;
  }
  const encoded: unknown = params[0];
  if (typeof encoded !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(encoded)) {
    return false;
  }
  try {
    const bytes = Uint8Array.from(encoded.slice(2).match(/../g) ?? [], byte => Number.parseInt(byte, 16));
    const fields = StatementFields.dec(bytes);
    let topic: string | null = null;
    for (const field of fields) {
      switch (field.tag) {
        case 'Topic1':
        case 'Topic2':
        case 'Topic3':
        case 'Topic4':
          if (topic !== null) {
            return false;
          }
          topic = field.value.toLowerCase();
          break;
        case 'Proof':
        case 'DecryptionKey':
        case 'Expiry':
        case 'Channel':
        case 'Data':
          break;
      }
    }
    return topic === VOX_PASEO_LOBBY_TOPIC;
  } catch {
    return false;
  }
}

function unsubscribeTarget(request: JsonRpcRequest<unknown>): SubscriptionId | null {
  const params: unknown = request.params;
  if (request.method !== 'statement_unsubscribeStatement' || !Array.isArray(params) || params.length !== 1) {
    return null;
  }
  return rpcId(params[0]);
}

export interface VoxPresenceSnapshotRoute {
  /** Send the exact Vox presence subscription, submit and unsubscribe lifecycle to the trusted node. */
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
        `[dot.li] TEMPORARY: no trusted RPC node for ${genesisHash}; Vox presence stays on the light client, which can miss other devices.`,
      );
      return null;
    }
    if (!announced) {
      announced = true;
      log.warn(
        '[dot.li] TEMPORARY: vox.paseo presence subscriptions and submissions use the trusted People RPC node; light-client peers can miss each other.',
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
      if (id !== null && isVoxPresenceSubmit(request)) {
        const connection = open();
        if (connection === null) {
          return false;
        }
        connection.send(request);
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
