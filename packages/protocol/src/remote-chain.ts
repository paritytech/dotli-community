// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// JSON-RPC connections to the chains the protocol frame runs.

import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { captureException, reportListener } from '@dotli/metrics';
import { log, serializeError } from '@dotli/shared';
import { chainHaltedError, type RemoteChainHalt } from '@dotli/chains';
import { ProtocolRequestError } from './errors.js';
import type { ProtocolFrame } from './frame.js';
import { isRemoteChainConnectable } from './remote-chain-support.js';
import { createRequestId, type FrameRpc } from './rpc.js';

interface RemoteChainConnection {
  onMessage: (message: JsonRpcMessage) => void;
  /** Told once when the chain behind this connection halts. */
  onHalt: ((reason: RemoteChainHalt) => void) | null;
  pendingMessages: JsonRpcRequest[];
  connected: boolean;
  /** The frame's loss count when this connection was opened. */
  openedAfterLosses: number;
}

/** `null` for a notification, which has no `id` to answer. */
function buildJsonRpcError(
  request: JsonRpcRequest,
  error: string | ReturnType<typeof chainHaltedError>,
): JsonRpcMessage | null {
  if (request.id === undefined || request.id === null) {
    return null;
  }
  return {
    jsonrpc: '2.0',
    id: request.id,
    error: typeof error === 'string' ? { code: -32603, message: error } : error,
  };
}

/** A consumer callback that throws is reported, not propagated, so the other consumers still hear the halt. */
function guardConsumer(label: 'halt' | 'message', call: () => void): void {
  try {
    call();
  } catch (err: unknown) {
    reportListener('protocol', `remote_chain.${label}`)(err);
  }
}

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

export interface RemoteChainsDeps {
  frame: Pick<ProtocolFrame, 'whenUp' | 'onEnvelope' | 'onLost' | 'losses'>;
  rpc: FrameRpc;
}

export function createRemoteChains({ frame, rpc }: RemoteChainsDeps) {
  const chainConnections = new Map<string, RemoteChainConnection>();

  frame.onEnvelope(msg => {
    if (msg.kind === 'chain-message') {
      const conn = chainConnections.get(msg.connectionId);
      // A message already on its way when its connection halted or closed, which the provider contract ignores.
      if (!conn) {
        log.debug(`[dot.li protocol] chain-message for a closed connection: ${msg.connectionId}`);
        return;
      }
      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(msg.message) as JsonRpcMessage;
      } catch (err: unknown) {
        captureException(err, { flow: 'protocol', step: 'chain_message_parse' });
        log.error(`[dot.li protocol] chain-message JSON parse failed (conn=${msg.connectionId.slice(-8)}):`, err);
        return;
      }
      guardConsumer('message', () => {
        conn.onMessage(parsed);
      });
      return;
    }
    if (msg.kind === 'chain-halt') {
      const halted = chainConnections.get(msg.connectionId);
      chainConnections.delete(msg.connectionId);
      if (halted !== undefined) {
        haltRemote(halted, 'chain');
      }
    }
  });

  // After the status changed, so a `'frame'` listener that dials again finds the frame down. A connection a status
  // listener opened on this loss waits for the next frame, so it is kept.
  frame.onLost(() => {
    const lossCount = frame.losses();
    const orphaned = [...chainConnections].filter(([, connection]) => connection.openedAfterLosses < lossCount);
    for (const [id, connection] of orphaned) {
      chainConnections.delete(id);
      haltRemote(connection, 'frame');
    }
  });

  function postDisconnect(connectionId: string): void {
    void rpc.request('chainDisconnect', { connectionId }).catch((error: unknown) => {
      log.warn('[dot.li protocol] Remote disconnect failed:', error);
    });
  }

  /** Null when the frame cannot connect this chain. */
  function createRemoteChainProvider(genesisHash: string): RemoteChainProvider | null {
    if (!isRemoteChainConnectable(genesisHash)) {
      return null;
    }

    return (onMessage, onHalt): JsonRpcConnection => {
      const connectionId = createRequestId();
      const remote: RemoteChainConnection = {
        onMessage,
        onHalt: onHalt ?? null,
        pendingMessages: [],
        connected: false,
        openedAfterLosses: frame.losses(),
      };

      chainConnections.set(connectionId, remote);
      // Not yet halted or disconnected. Whoever removes it tells the consumer.
      const isOpen = (): boolean => chainConnections.get(connectionId) === remote;

      void frame
        .whenUp('ready')
        .then(async () => {
          // Disconnected before the connect is posted: the frame never hears of it.
          if (!isOpen()) {
            return;
          }
          await rpc.request('chainConnect', { genesisHash, connectionId });
          // Disconnected while the connect was in flight: it is closed in the
          // frame now that the connect settled, not before, or the frame would
          // keep a connection opened after its disconnect.
          if (!isOpen()) {
            postDisconnect(connectionId);
            return;
          }
          remote.connected = true;
          for (const message of remote.pendingMessages) {
            void rpc
              .request('chainSend', {
                connectionId,
                message: JSON.stringify(message),
              })
              .catch((error: unknown) => {
                if (!isOpen()) {
                  return;
                }
                const errResponse = buildJsonRpcError(message, serializeError(error));
                if (errResponse !== null) {
                  onMessage(errResponse);
                }
              });
          }
          remote.pendingMessages = [];
        })
        .catch((error: unknown) => {
          // A frame too busy to answer in time may still accept the connect and would hold its slot for good, even
          // when the consumer has already disconnected. A refusal, a dead frame or a connect never posted holds
          // nothing, and a disconnect would boot a frame for it.
          if (error instanceof ProtocolRequestError && error.name === 'ProtocolTimeoutError') {
            postDisconnect(connectionId);
          }
          if (!isOpen()) {
            return;
          }
          // Halts like a dead frame so a caching consumer drops it. Removed first so a send made during
          // the halt is answered at once, not queued and lost.
          log.error('[dot.li protocol] Failed to connect remote chain:', error);
          chainConnections.delete(connectionId);
          haltRemote(remote, 'frame');
        });

      return {
        send(message) {
          if (!isOpen()) {
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
          void rpc
            .request('chainSend', {
              connectionId,
              message: JSON.stringify(message),
            })
            .catch((error: unknown) => {
              // A papi client re-follows on the `stop` that comes before
              // `chain-halt`, and the frame refuses that send for a connection it
              // has already forgotten.
              if (!isOpen()) {
                return;
              }
              const reason = serializeError(error);
              log.error('[dot.li protocol] Remote chain send failed:', error);
              const errResponse = buildJsonRpcError(message, reason);
              if (errResponse !== null) {
                onMessage(errResponse);
              }
            });
        },
        disconnect() {
          const wasOpen = isOpen();
          chainConnections.delete(connectionId);
          // Not accepted yet: a connect not posted is never posted, and one in
          // flight is closed in the frame once it settles.
          if (wasOpen && remote.connected) {
            postDisconnect(connectionId);
          }
        },
      };
    };
  }

  return { createRemoteChainProvider };
}
