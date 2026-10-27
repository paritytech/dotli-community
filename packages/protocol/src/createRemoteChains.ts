// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// JSON-RPC connections to the chains the protocol frame serves.

import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { captureException, m, reportListener, spans as S } from '@dotli/metrics';
import { getErrorName, log, setErrorName, createRandomId, serializeError } from '@dotli/shared';
import { createChainHaltedError, createJsonRpcError, type RemoteChainHalt } from '@dotli/chains';
import type { FrameRpc } from './createFrameRpc.js';
import { isRemoteChainConnectable } from './isRemoteChainConnectable.js';
import { protocolSchema, type ProtocolTransport } from './schema.js';
import { subscribe } from './subscribe.js';

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

type Params = {
  rpc: FrameRpc;
};

type RemoteChainConnection = {
  onMessage: (message: JsonRpcMessage) => void;
  /** Told once when the chain behind this connection halts. */
  onHalt: ((reason: RemoteChainHalt) => void) | null;
  /** What the consumer sent before the frame accepted the connection, in order. */
  pendingMessages: JsonRpcRequest[];
  connected: boolean;
};

/** One connection of the consumer's, under its id. */
type ConnectionParams = {
  connectionId: string;
  connection: RemoteChainConnection;
};

const { chain } = protocolSchema.sections;

/** Connections to the frame's chains, each request on `rpc`. */
export function createRemoteChains({ rpc }: Params) {
  const chainConnections = new Map<string, RemoteChainConnection>();

  /** Hands one chain message to its connection. One that is not JSON is reported and dropped. */
  function deliver({ connectionId, connection, message }: ConnectionParams & { message: string }): void {
    let parsed: JsonRpcMessage;
    try {
      // The frame relays the chain's JSON-RPC text as it is, and the consumer reads it as a JSON-RPC message.
      parsed = JSON.parse(message) as JsonRpcMessage;
    } catch (error: unknown) {
      captureException(error, { flow: 'protocol', step: 'chain_message_parse' });
      log.error(`[dot.li protocol] chain-message JSON parse failed (conn=${connectionId.slice(-8)}):`, error);
      m.count(S.PROTOCOL_CHAIN_MESSAGE, { outcome: 'error', reason: getErrorName(error) ?? 'unknown' });
      return;
    }
    guardConsumer('message', () => {
      connection.onMessage(parsed);
    });
  }

  /** Not yet halted or disconnected. Whoever removes it tells the consumer. */
  function isOpen({ connectionId, connection }: ConnectionParams): boolean {
    return chainConnections.get(connectionId) === connection;
  }

  /** Sends one message once the frame accepted the connection. A refusal reaches the consumer as its answer. */
  function send({ connectionId, connection, message }: ConnectionParams & { message: JsonRpcRequest }): void {
    void rpc.request(chain.send, { connectionId, message: JSON.stringify(message) }).catch((error: unknown) => {
      // A papi client re-follows on the `stop` that comes before the halt, and the frame refuses that send for a
      // connection it has already forgotten.
      if (!isOpen({ connectionId, connection })) {
        return;
      }
      log.error('[dot.li protocol] Remote chain send failed:', error);
      const errorResponse = buildJsonRpcError(message, serializeError(error));
      if (errorResponse !== null) {
        connection.onMessage(errorResponse);
      }
    });
  }

  /**
   * Subscribes the chain once the frame is ready. Sends wait for `connected`. The connect has its own budget, and
   * running out of it unsubscribes, which disconnects a connection a busy frame may still accept. Returns the
   * consumer's disconnect.
   */
  function open({ genesisHash, connectionId, connection }: ConnectionParams & { genesisHash: string }): () => void {
    const leave = new AbortController();

    function subscribeChain(transport: ProtocolTransport, signal: AbortSignal): Promise<void> {
      return new Promise((resolve, reject) => {
        subscribe({
          transport,
          method: chain.connect,
          start: { genesisHash, connectionId },
          listeners: {
            receive: event => {
              if (event.tag === 'message') {
                deliver({ connectionId, connection, message: event.value });
                return;
              }
              if (connection.connected || !isOpen({ connectionId, connection })) {
                return;
              }
              connection.connected = true;
              resolve();
              for (const message of connection.pendingMessages.splice(0)) {
                send({ connectionId, connection, message });
              }
            },
            // A clean end is the chain halting. An error is a refusal, a connect that ran out of budget, or a frame
            // that went down, and halts like a dead frame so a caching consumer drops it.
            end: error => {
              if (!connection.connected) {
                reject(error ?? new Error('Chain halted before it connected'));
              }
              if (!isOpen({ connectionId, connection })) {
                return;
              }
              // Removed first, so a send made during the halt is answered at once, not queued and lost.
              chainConnections.delete(connectionId);
              if (error !== null && !connection.connected) {
                log.error('[dot.li protocol] Failed to connect remote chain:', error);
              }
              haltRemote(connection, error === null ? 'chain' : 'frame');
            },
          },
          signal,
        });
      });
    }

    void rpc.call(chain.connect, subscribeChain, { signal: leave.signal }).catch((error: unknown) => {
      // Counted on the call's trail. A connection still open never subscribed, since the frame did not come up, and
      // halts like a dead frame. Otherwise the subscription's end, or the consumer's disconnect, already acted on it.
      if (!isOpen({ connectionId, connection })) {
        return;
      }
      log.error('[dot.li protocol] Failed to connect remote chain:', error);
      chainConnections.delete(connectionId);
      haltRemote(connection, 'frame');
    });
    // A consumer that leaves before `connected` ends the connect as a disconnect, so its trail still ends. A connect
    // still queued is never sent, one the frame has is closed there, and one the frame is not up for never goes out.
    return () => {
      leave.abort(createDisconnectedError());
    };
  }

  function createProvider(genesisHash: string): RemoteChainProvider | null {
    if (!isRemoteChainConnectable(genesisHash)) {
      return null;
    }

    function connectChain(
      onMessage: (message: JsonRpcMessage) => void,
      onHalt?: (reason: RemoteChainHalt) => void,
    ): JsonRpcConnection {
      const connectionId = createRandomId();
      const connection: RemoteChainConnection = {
        onMessage,
        onHalt: onHalt ?? null,
        pendingMessages: [],
        connected: false,
      };
      chainConnections.set(connectionId, connection);
      const disconnect = open({ genesisHash, connectionId, connection });

      return {
        send(message) {
          if (!isOpen({ connectionId, connection })) {
            const errorResponse = buildJsonRpcError(message, 'Chain connection is closed');
            if (errorResponse !== null) {
              onMessage(errorResponse);
            }
            return;
          }
          if (!connection.connected) {
            connection.pendingMessages.push(message);
            return;
          }
          send({ connectionId, connection, message });
        },
        disconnect() {
          if (!isOpen({ connectionId, connection })) {
            return;
          }
          chainConnections.delete(connectionId);
          disconnect();
        },
      };
    }

    return connectChain;
  }

  return {
    /**
     * A provider of connections to the chain of `genesisHash` in the frame, or null when the frame cannot connect this
     * chain. Never throws.
     */
    createProvider,
  };
}

/** `null` for a notification, which has no `id` to answer. */
function buildJsonRpcError(
  request: JsonRpcRequest,
  error: string | ReturnType<typeof createChainHaltedError>,
): JsonRpcMessage | null {
  return request.id === undefined || request.id === null ? null : createJsonRpcError(request.id, error);
}

/** A consumer callback that throws is reported, not propagated, so the other consumers still hear the halt. */
function guardConsumer(label: 'halt' | 'message', call: () => void): void {
  try {
    call();
  } catch (error: unknown) {
    reportListener('protocol', `remote_chain.${label}`)(error);
  }
}

/** What a connect that the consumer left before it connected settles with. */
function createDisconnectedError(): Error {
  return setErrorName(new Error('Chain disconnected before it connected'), 'ChainDisconnectedError');
}

/** What an unsent message is answered with: the retryable halt error on a chain halt, a plain close on a dead frame. */
function getHaltAnswer(reason: RemoteChainHalt): string | ReturnType<typeof createChainHaltedError> {
  switch (reason) {
    case 'chain':
      return createChainHaltedError();
    case 'frame':
      return 'Chain connection is closed';
  }
}

/** Answers every unsent message as `reason` says, then tells the consumer of the halt. */
function haltRemote(connection: RemoteChainConnection, reason: RemoteChainHalt): void {
  for (const message of connection.pendingMessages) {
    const errorResponse = buildJsonRpcError(message, getHaltAnswer(reason));
    if (errorResponse !== null) {
      guardConsumer('message', () => {
        connection.onMessage(errorResponse);
      });
    }
  }
  connection.pendingMessages = [];
  guardConsumer('halt', () => {
    connection.onHalt?.(reason);
  });
}
