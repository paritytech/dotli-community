// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// JSON-RPC connections to the chains the protocol frame runs.

import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { captureException, m, reportListener, spans as S } from '@dotli/metrics';
import { errorName, log, realTimers, serializeError, toError, withTimeout, type Timers } from '@dotli/shared';
import { chainHaltedError, jsonRpcError, type RemoteChainHalt } from '@dotli/chains';
import type { ProtocolFrame } from './frame.js';
import { budgetOf, DEFAULT_TIMEOUT_MS } from './method-timeouts.js';
import { isRemoteChainConnectable } from './remote-chain-support.js';
import { callTimeoutError, createRequestId, startCallTrail, type FrameRpc } from './rpc.js';
import type { ConsumerTransport, Subscription } from './transport-consumer.js';

// A timed method, so the default is never taken.
const CONNECT_BUDGET_MS = budgetOf('chainConnect') ?? DEFAULT_TIMEOUT_MS;

interface RemoteChainConnection {
  onMessage: (message: JsonRpcMessage) => void;
  /** Told once when the chain behind this connection halts. */
  onHalt: ((reason: RemoteChainHalt) => void) | null;
  /** What the consumer sent before the frame accepted the connection, in order. */
  pendingMessages: JsonRpcRequest[];
  connected: boolean;
  /** Null until the frame is ready and the connect goes out. */
  subscription: Subscription | null;
}

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
  frame: Pick<ProtocolFrame, 'whenUp'>;
  rpc: FrameRpc;
  timers?: Timers;
}

export function createRemoteChains({ frame, rpc, timers = realTimers }: RemoteChainsDeps) {
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
    void rpc.request('chainSend', { connectionId, message: JSON.stringify(message) }).catch((error: unknown) => {
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
   * Subscribes the chain on the ready frame's transport. Sends wait for `connected`. The connect has its own budget,
   * and running out of it unsubscribes, which disconnects a connection a busy frame may still accept.
   */
  function open(
    transport: ConsumerTransport,
    genesisHash: string,
    connectionId: string,
    remote: RemoteChainConnection,
  ) {
    const giveUp = new AbortController();
    const trail = startCallTrail('chainConnect', CONNECT_BUDGET_MS);
    let timedOut: Error | undefined;
    let settleConnect: (error: Error | null) => void = () => undefined;
    const connected = new Promise<void>((resolve, reject) => {
      settleConnect = error => {
        if (error === null) {
          resolve();
        } else {
          reject(error);
        }
      };
    });
    const subscription = transport.subscribe(
      'chainConnect',
      { genesisHash, connectionId },
      event => {
        if (event.tag === 'message') {
          deliver(connectionId, remote, event.value);
          return;
        }
        if (remote.connected || !isOpen(connectionId, remote)) {
          return;
        }
        remote.connected = true;
        settleConnect(null);
        for (const message of remote.pendingMessages.splice(0)) {
          send(connectionId, remote, message);
        }
      },
      { deadlineMs: timers.now() + CONNECT_BUDGET_MS, signal: giveUp.signal },
    );
    remote.subscription = subscription;
    // A clean end is the chain halting. An error is a refusal, a connect that ran out of budget, or a frame that went
    // down, and halts like a dead frame so a caching consumer drops it.
    subscription.onEnd(error => {
      if (!remote.connected) {
        settleConnect(error ?? new Error('Chain halted before it connected'));
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
    });
    void withTimeout(
      connected,
      CONNECT_BUDGET_MS,
      () => {
        timedOut = callTimeoutError('chainConnect', CONNECT_BUDGET_MS);
        return timedOut;
      },
      timers,
    ).then(
      () => {
        // Also settled by a consumer that disconnected first, which is no connect to measure.
        if (remote.connected) {
          trail.settled('ok');
        }
      },
      (error: unknown) => {
        const err = toError(error);
        trail.settled(err === timedOut ? 'timeout' : 'error', err);
        giveUp.abort(err);
      },
    );
    return () => {
      settleConnect(null);
    };
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
        subscription: null,
      };
      chainConnections.set(connectionId, remote);
      let stopConnect = (): void => undefined;

      void frame.whenUp('ready').then(
        transport => {
          // Disconnected before the frame was up: the frame never hears of it.
          if (isOpen(connectionId, remote)) {
            stopConnect = open(transport, genesisHash, connectionId, remote);
          }
        },
        (error: unknown) => {
          if (!isOpen(connectionId, remote)) {
            return;
          }
          log.error('[dot.li protocol] Failed to connect remote chain:', error);
          chainConnections.delete(connectionId);
          haltRemote(remote, 'frame');
        },
      );

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
          // A connect still queued is never sent, and one the frame has is closed there.
          remote.subscription?.unsubscribe();
          stopConnect();
        },
      };
    };
  }

  return { createRemoteChainProvider };
}
