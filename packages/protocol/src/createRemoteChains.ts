// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// JSON-RPC connections to the chains the protocol frame serves.

import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createRandomId,
  createStateMachine,
  log,
  nest,
  serializeError,
  setErrorName,
  type HandlerOf,
  type MachineTypes,
  type Transition,
} from '@dotli/shared';
import { createChainHaltedError, createJsonRpcError, type RemoteChainHalt } from '@dotli/chains';
import type { FrameRpc } from './createFrameRpc.js';
import { isRemoteChainConnectable } from './isRemoteChainConnectable.js';
import { protocolSchema, type ProtocolTransport } from './schema.js';
import { subscribe } from './subscribe.js';

const report = createReporter({ flow: 'protocol' });

/**
 * A chain message from the protocol frame that the host could not parse, so its connection never hears it. Tagged
 * `outcome` (error) and `reason` (the error's name).
 */
const protocolChainMessageMetric = defineCount<'error'>('protocol.chain_message');

/**
 * A remote chains transition that threw. Tagged `outcome` (error) and `reason` (the error's name).
 */
const remoteChainsTransitionMetric = defineCount<'error'>('protocol.remote_chains_transition');

/**
 * A remote chain provider whose connections may hear `onHalt` once:
 *
 * - `'chain'`: the chain halted and is rebuilt on the next connect. Every request in flight or unsent
 *   gets an error with `CHAIN_HALTED_ERROR_DATA`, and every follow its `stop`.
 * - `'frame'`: the frame died, never came up or refused the connection. Only unsent requests are
 *   answered, so a consumer without `onHalt` may wait on the rest forever.
 *
 * Later sends fail with `Chain connection is closed`. A chain message that arrives after the halt or the disconnect is
 * dropped.
 */
export type RemoteChainProvider = (
  onMessage: (message: JsonRpcMessage) => void,
  onHalt?: (reason: RemoteChainHalt) => void,
) => JsonRpcConnection;

type Params = {
  rpc: FrameRpc;
};

/** The side of a connection that hears it. */
type Consumer = {
  onMessage: (message: JsonRpcMessage) => void;
  /** Told once when the chain behind this connection halts. */
  onHalt: ((reason: RemoteChainHalt) => void) | null;
};

/**
 * One connection. `pending` is what the consumer sent before the frame accepted the connection, in order. `leave`
 * ends the connect, and the subscription once it is up. A closed connection leaves the table.
 */
type Connection =
  | { kind: 'connecting'; consumer: Consumer; pending: readonly JsonRpcRequest[]; leave: AbortController }
  | { kind: 'connected'; consumer: Consumer; leave: AbortController }
  | { kind: 'closed' };

type ChainsState = { kind: 'open'; connections: ReadonlyMap<string, Connection> };

type ChainsEvent =
  | { kind: 'opened'; connectionId: string; genesisHash: string; consumer: Consumer }
  | { kind: 'chainConnected'; connectionId: string }
  | { kind: 'chainMessage'; connectionId: string; message: string }
  | { kind: 'chainEnded'; connectionId: string; error: Error | null }
  | { kind: 'connectFailed'; connectionId: string; error: unknown }
  | { kind: 'consumerSent'; connectionId: string; request: JsonRpcRequest; consumer: Consumer }
  | { kind: 'sendAnswered'; connectionId: string }
  | { kind: 'sendFailed'; connectionId: string; request: JsonRpcRequest; error: unknown }
  | { kind: 'disconnected'; connectionId: string };

type ChainsEffect =
  | { kind: 'messageUnparsed'; connectionId: string; error: unknown }
  | { kind: 'connectErrored'; error: unknown }
  | { kind: 'sendErrored'; error: unknown };

type ChainsMachine = MachineTypes<ChainsState, ChainsEvent, ChainsEffect>;

type ConnectionMachine = MachineTypes<Connection, ChainsEvent, ChainsEffect>;

const { chain } = protocolSchema.sections;

/** Connections to the frame's chains, each request on `rpc`. */
export function createRemoteChains({ rpc }: Params) {
  /** Sends one request once the frame accepted the connection. A refusal reaches the consumer as its answer. */
  function sendRequest(connectionId: string, request: JsonRpcRequest, { update }: Transition<ConnectionMachine>): void {
    update(
      rpc.request(chain.send, { connectionId, message: JSON.stringify(request) }).then(
        (): ChainsEvent => ({ kind: 'sendAnswered', connectionId }),
        (error: unknown): ChainsEvent => ({ kind: 'sendFailed', connectionId, request, error }),
      ),
    );
  }

  /** Hands one chain message to its consumer. One that is not JSON is reported and dropped. */
  const deliverMessage: HandlerOf<ConnectionMachine, 'connecting' | 'connected', 'chainMessage'> = (
    { consumer },
    { connectionId, message },
    { emitSideEffect },
  ) => {
    let parsed: JsonRpcMessage;
    try {
      // The frame relays the chain's JSON-RPC text as it is, and the consumer reads it as a JSON-RPC message.
      parsed = JSON.parse(message) as JsonRpcMessage;
    } catch (error: unknown) {
      emitSideEffect({ kind: 'messageUnparsed', connectionId, error });
      return;
    }
    guardConsumer('message', () => {
      consumer.onMessage(parsed);
    });
  };

  // A clean end is the chain halting. An error is a refusal, a connect that ran out of budget, or a frame that went
  // down, and halts like a dead frame so a caching consumer drops it.
  const endChain: HandlerOf<ConnectionMachine, 'connecting' | 'connected', 'chainEnded'> = (
    connection,
    { error },
    { emitState, emitSideEffect },
  ) => {
    // Closed first, so a send made during the halt is answered at once, not queued and lost.
    emitState({ kind: 'closed' });
    if (error !== null && connection.kind === 'connecting') {
      emitSideEffect({ kind: 'connectErrored', error });
    }
    haltRemote(connection, error === null ? 'chain' : 'frame');
  };

  // A consumer that leaves before `connected` ends the connect as a disconnect, so its trail still ends. A connect
  // still queued is never sent, one the frame has is closed there, and one the frame is not up for never goes out.
  const leaveChain: HandlerOf<ConnectionMachine, 'connecting' | 'connected', 'disconnected'> = (
    { leave },
    _event,
    { emitState },
  ) => {
    emitState({ kind: 'closed' });
    leave.abort(createDisconnectedError());
  };

  const handleConnection = nest<
    ChainsMachine,
    'open',
    ConnectionMachine,
    'chainConnected' | 'chainMessage' | 'chainEnded' | 'connectFailed' | 'consumerSent' | 'sendFailed' | 'disconnected'
  >({
    find: ({ connections }, { connectionId }) => connections.get(connectionId) ?? null,
    store(state, { connectionId }, next) {
      const connections = new Map(state.connections);
      switch (next.kind) {
        case 'connecting':
        case 'connected':
          connections.set(connectionId, next);
          break;
        case 'closed':
          connections.delete(connectionId);
          break;
      }
      return { ...state, connections };
    },
    handlers: {
      connecting: {
        chainConnected({ consumer, pending, leave }, { connectionId }, transition) {
          transition.emitState({ kind: 'connected', consumer, leave });
          for (const request of pending) {
            sendRequest(connectionId, request, transition);
          }
        },
        chainMessage: deliverMessage,
        chainEnded: endChain,
        // The connect never subscribed, since the frame did not come up, and halts like a dead frame.
        connectFailed(connection, { error }, { emitState, emitSideEffect }) {
          emitState({ kind: 'closed' });
          emitSideEffect({ kind: 'connectErrored', error });
          haltRemote(connection, 'frame');
        },
        consumerSent(connection, { request }, { emitState }) {
          emitState({ ...connection, pending: [...connection.pending, request] });
        },
        disconnected: leaveChain,
      },
      connected: {
        chainMessage: deliverMessage,
        chainEnded: endChain,
        consumerSent(_connection, { connectionId, request }, transition) {
          sendRequest(connectionId, request, transition);
        },
        // A refusal reaches the consumer as the answer to its request.
        sendFailed({ consumer }, { request, error }, { emitSideEffect }) {
          emitSideEffect({ kind: 'sendErrored', error });
          const errorResponse = buildJsonRpcError(request, serializeError(error));
          if (errorResponse !== null) {
            guardConsumer('message', () => {
              consumer.onMessage(errorResponse);
            });
          }
        },
        disconnected: leaveChain,
      },
      closed: null,
    },
  });

  const chains = createStateMachine<ChainsMachine>({
    initial: { kind: 'open', connections: new Map() },
    handlers: {
      open: {
        // Subscribes the chain once the frame is ready. Sends wait for `connected`. The connect has its own budget, and
        // running out of it unsubscribes, which disconnects a connection a busy frame may still accept.
        opened(state, { connectionId, genesisHash, consumer }, { emitState, update }) {
          const leave = new AbortController();
          emitState({
            ...state,
            connections: new Map(state.connections).set(connectionId, {
              kind: 'connecting',
              consumer,
              pending: [],
              leave,
            }),
          });

          // A second resolve or reject does nothing, so no listener reads the connection's phase.
          function subscribeChain(transport: ProtocolTransport, signal: AbortSignal): Promise<void> {
            return new Promise((resolve, reject) => {
              subscribe({
                transport,
                method: chain.connect,
                start: { genesisHash, connectionId },
                listeners: {
                  receive: event => {
                    if (event.tag === 'message') {
                      update({ kind: 'chainMessage', connectionId, message: event.value });
                      return;
                    }
                    resolve();
                    update({ kind: 'chainConnected', connectionId });
                  },
                  end: error => {
                    reject(error ?? new Error('Chain halted before it connected'));
                    update({ kind: 'chainEnded', connectionId, error });
                  },
                },
                signal,
              });
            });
          }

          update(
            rpc.call(chain.connect, subscribeChain, { signal: leave.signal }).then(
              (): ChainsEvent => ({ kind: 'chainConnected', connectionId }),
              (error: unknown): ChainsEvent => ({ kind: 'connectFailed', connectionId, error }),
            ),
          );
        },
        chainConnected: handleConnection,
        chainMessage: handleConnection,
        chainEnded: handleConnection,
        connectFailed: handleConnection,
        consumerSent(state, event, transition) {
          if (!state.connections.has(event.connectionId)) {
            const errorResponse = buildJsonRpcError(event.request, 'Chain connection is closed');
            if (errorResponse !== null) {
              guardConsumer('message', () => {
                event.consumer.onMessage(errorResponse);
              });
            }
            return;
          }
          handleConnection(state, event, transition);
        },
        sendFailed: handleConnection,
        disconnected: handleConnection,
      },
    },
    onEffect(effect) {
      switch (effect.kind) {
        case 'messageUnparsed':
          report.defect(effect.error, {
            step: 'chain_message_parse',
            metric: protocolChainMessageMetric,
            message: `[dot.li protocol] chain-message JSON parse failed (conn=${effect.connectionId.slice(-8)}):`,
          });
          return;
        case 'connectErrored':
          log.error('[dot.li protocol] Failed to connect remote chain:', effect.error);
          return;
        case 'sendErrored':
          log.error('[dot.li protocol] Remote chain send failed:', effect.error);
          return;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'remote_chains_transition',
        metric: remoteChainsTransitionMetric,
        message: '[dot.li protocol] A remote chains transition threw',
      });
    },
  });

  function createProvider(genesisHash: string): RemoteChainProvider | null {
    if (!isRemoteChainConnectable(genesisHash)) {
      return null;
    }

    function connectChain(
      onMessage: (message: JsonRpcMessage) => void,
      onHalt?: (reason: RemoteChainHalt) => void,
    ): JsonRpcConnection {
      const connectionId = createRandomId();
      const consumer: Consumer = { onMessage, onHalt: onHalt ?? null };
      chains.update({ kind: 'opened', connectionId, genesisHash, consumer });

      return {
        send(request) {
          chains.update({ kind: 'consumerSent', connectionId, request, consumer });
        },
        disconnect() {
          chains.update({ kind: 'disconnected', connectionId });
        },
      };
    }

    return connectChain;
  }

  return {
    /**
     * A provider of connections to the chain of `genesisHash` in the frame, or null when the frame cannot connect this
     * chain.
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
    report.listener(`remote_chain.${label}`)(error);
  }
}

/** What a connect that the consumer left before it connected settles with. */
function createDisconnectedError(): Error {
  return setErrorName(new Error('Chain disconnected before it connected'), 'ChainDisconnectedError');
}

/** Answers every unsent message as `reason` says, then tells the consumer of the halt. */
function haltRemote(connection: Exclude<Connection, { kind: 'closed' }>, reason: RemoteChainHalt): void {
  if (connection.kind === 'connecting') {
    let answer: Parameters<typeof buildJsonRpcError>[1];
    switch (reason) {
      case 'chain':
        // Retryable, unlike the dead frame's plain close.
        answer = createChainHaltedError();
        break;
      case 'frame':
        answer = 'Chain connection is closed';
        break;
    }
    for (const request of connection.pending) {
      const errorResponse = buildJsonRpcError(request, answer);
      if (errorResponse !== null) {
        guardConsumer('message', () => {
          connection.consumer.onMessage(errorResponse);
        });
      }
    }
  }
  guardConsumer('halt', () => {
    connection.consumer.onHalt?.(reason);
  });
}
