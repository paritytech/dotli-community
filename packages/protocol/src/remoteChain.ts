// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Which chains the protocol frame serves, and JSON-RPC connections to them.

import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { captureException, m, reportListener, spans as S } from '@dotli/metrics';
import { errorName, log, named, randomId, serializeError } from '@dotli/shared';
import { chainHaltedError, jsonRpcError, type RemoteChainHalt } from '@dotli/chains';
import {
  getActiveCoreGatewaySupportedGenesisHashes,
  getActiveGatewaySupportedGenesisHashes,
  getActiveSupportedGenesisHashes,
  getBackend,
} from '@dotli/config';

import type { FrameRpc } from './rpc.js';
import { protocolSchema, type ProtocolTransport } from './schema.js';

import { subscribe } from './subscription.js';

const { chain } = protocolSchema.sections;

/**
 * Wider than the advertised `isRemoteChainSupported`, since gateway mode keeps Bulletin connectable for bitswap's
 * content fetches through the frame.
 */
export function isRemoteChainConnectable(genesisHash: string): boolean {
  const supported =
    getBackend() === 'rpc-gateway' ? getActiveCoreGatewaySupportedGenesisHashes() : getActiveSupportedGenesisHashes();
  return supported.has(genesisHash.toLowerCase());
}

export function isRemoteChainSupported(genesisHash: string): boolean {
  // Gateway mode bridges a curated RPC subset, while smoldot can run any configured chain.
  const supported =
    getBackend() === 'rpc-gateway' ? getActiveGatewaySupportedGenesisHashes() : getActiveSupportedGenesisHashes();
  return supported.has(genesisHash.toLowerCase());
}

type RemoteChainConnection = {
  onMessage: (message: JsonRpcMessage) => void;
  /** Told once when the chain behind this connection halts. */
  onHalt: ((reason: RemoteChainHalt) => void) | null;
  /** What the consumer sent before the frame accepted the connection, in order. */
  pendingMessages: JsonRpcRequest[];
  connected: boolean;
};

/** `null` for a notification, which has no `id` to answer. */
function buildJsonRpcError(
  request: JsonRpcRequest,
  error: string | ReturnType<typeof chainHaltedError>,
): JsonRpcMessage | null {
  return request.id === undefined || request.id === null ? null : jsonRpcError(request.id, error);
}

/** A consumer callback that throws is reported, not propagated, so the other consumers still hear the halt. */
function guardConsumer(label: 'halt' | 'message', call: () => void): void {
  try {
    call();
  } catch (err: unknown) {
    reportListener('protocol', `remote_chain.${label}`)(err);
  }
}

/** What a connect that the consumer left before it connected settles with. */
const disconnectedError = (): Error =>
  named(new Error('Chain disconnected before it connected'), 'ChainDisconnectedError');

/** Unsent messages get the retryable halt error on a chain halt, and a plain close error on a dead frame. */
function haltRemote(connection: RemoteChainConnection, reason: RemoteChainHalt): void {
  for (const message of connection.pendingMessages) {
    const errResponse = buildJsonRpcError(
      message,
      reason === 'chain' ? chainHaltedError() : 'Chain connection is closed',
    );
    if (errResponse !== null) {
      guardConsumer('message', () => {
        connection.onMessage(errResponse);
      });
    }
  }
  connection.pendingMessages = [];
  guardConsumer('halt', () => {
    connection.onHalt?.(reason);
  });
}

/**
 * A remote chain provider whose connections may hear `onHalt` once:
 *
 * - `'chain'`: the chain halted and is rebuilt on the next connect. Every request in flight or unsent
 *   gets an error with `CHAIN_HALTED_ERROR_DATA`, and every follow its `stop`.
 * - `'frame'`: the frame died, never came up or refused the connection. Only unsent requests are
 *   answered, so a consumer without `onHalt` may wait on the rest forever.
 *
 * Later sends fail with `Chain connection is closed`. A message already on its way may still arrive
 * after `onHalt` and should be ignored.
 */
export type RemoteChainProvider = (
  onMessage: (message: JsonRpcMessage) => void,
  onHalt?: (reason: RemoteChainHalt) => void,
) => JsonRpcConnection;

export function createRemoteChains(rpc: FrameRpc) {
  const chainConnections = new Map<string, RemoteChainConnection>();

  /** Hands one chain message to its connection. One that is not JSON is reported and dropped. */
  function deliver(connectionId: string, connection: RemoteChainConnection, message: string): void {
    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(message) as JsonRpcMessage;
    } catch (err: unknown) {
      captureException(err, { flow: 'protocol', step: 'chain_message_parse' });
      log.error(`[dot.li protocol] chain-message JSON parse failed (conn=${connectionId.slice(-8)}):`, err);
      m.count(S.PROTOCOL_CHAIN_MESSAGE, { outcome: 'error', reason: errorName(err) ?? 'unknown' });
      return;
    }
    guardConsumer('message', () => {
      connection.onMessage(parsed);
    });
  }

  /** Not yet halted or disconnected. Whoever removes it tells the consumer. */
  function isOpen(connectionId: string, connection: RemoteChainConnection): boolean {
    return chainConnections.get(connectionId) === connection;
  }

  /** Sends one message once the frame accepted the connection. A refusal reaches the consumer as its answer. */
  function send(connectionId: string, connection: RemoteChainConnection, message: JsonRpcRequest): void {
    void rpc.request(chain.send, { connectionId, message: JSON.stringify(message) }).catch((error: unknown) => {
      // A papi client re-follows on the `stop` that comes before the halt, and the frame refuses that send for a
      // connection it has already forgotten.
      if (!isOpen(connectionId, connection)) {
        return;
      }
      log.error('[dot.li protocol] Remote chain send failed:', error);
      const errResponse = buildJsonRpcError(message, serializeError(error));
      if (errResponse !== null) {
        connection.onMessage(errResponse);
      }
    });
  }

  /**
   * Subscribes the chain once the frame is ready. Sends wait for `connected`. The connect has its own budget, and
   * running out of it unsubscribes, which disconnects a connection a busy frame may still accept. Returns the
   * consumer's disconnect.
   */
  function open(genesisHash: string, connectionId: string, remote: RemoteChainConnection): () => void {
    const leave = new AbortController();
    const connect = (transport: ProtocolTransport, signal: AbortSignal): Promise<void> =>
      new Promise((resolve, reject) => {
        subscribe(
          transport,
          chain.connect,
          { genesisHash, connectionId },
          {
            receive: event => {
              if (event.tag === 'message') {
                deliver(connectionId, remote, event.value);
                return;
              }
              if (remote.connected || !isOpen(connectionId, remote)) {
                return;
              }
              remote.connected = true;
              resolve();
              for (const message of remote.pendingMessages.splice(0)) {
                send(connectionId, remote, message);
              }
            },
            // A clean end is the chain halting. An error is a refusal, a connect that ran out of budget, or a frame
            // that went down, and halts like a dead frame so a caching consumer drops it.
            end: error => {
              if (!remote.connected) {
                reject(error ?? new Error('Chain halted before it connected'));
              }
              if (!isOpen(connectionId, remote)) {
                return;
              }
              // Removed first, so a send made during the halt is answered at once, not queued and lost.
              chainConnections.delete(connectionId);
              if (error !== null && !remote.connected) {
                log.error('[dot.li protocol] Failed to connect remote chain:', error);
              }
              haltRemote(remote, error === null ? 'chain' : 'frame');
            },
          },
          { signal },
        );
      });
    void rpc.call(chain.connect, connect, { signal: leave.signal }).catch((error: unknown) => {
      // Counted on the call's trail. A connection still open never subscribed, since the frame did not come up, and
      // halts like a dead frame. Otherwise the subscription's end, or the consumer's disconnect, already acted on it.
      if (!isOpen(connectionId, remote)) {
        return;
      }
      log.error('[dot.li protocol] Failed to connect remote chain:', error);
      chainConnections.delete(connectionId);
      haltRemote(remote, 'frame');
    });
    // A consumer that leaves before `connected` ends the connect as a disconnect, so its trail still ends. A connect
    // still queued is never sent, one the frame has is closed there, and one the frame is not up for never goes out.
    return () => {
      leave.abort(disconnectedError());
    };
  }

  /** Null when the frame cannot connect this chain. */
  function createRemoteChainProvider(genesisHash: string): RemoteChainProvider | null {
    if (!isRemoteChainConnectable(genesisHash)) {
      return null;
    }

    return (onMessage, onHalt): JsonRpcConnection => {
      const connectionId = randomId();
      const remote: RemoteChainConnection = {
        onMessage,
        onHalt: onHalt ?? null,
        pendingMessages: [],
        connected: false,
      };
      chainConnections.set(connectionId, remote);
      const disconnect = open(genesisHash, connectionId, remote);

      return {
        send(message) {
          if (!isOpen(connectionId, remote)) {
            const errResponse = buildJsonRpcError(message, 'Chain connection is closed');
            if (errResponse !== null) {
              onMessage(errResponse);
            }
            return;
          }
          if (!remote.connected) {
            remote.pendingMessages.push(message);
            return;
          }
          send(connectionId, remote, message);
        },
        disconnect() {
          if (!isOpen(connectionId, remote)) {
            return;
          }
          chainConnections.delete(connectionId);
          disconnect();
        },
      };
    };
  }

  return { createRemoteChainProvider };
}
