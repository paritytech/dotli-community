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
  toError,
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

/** What a request that never got its own answer is answered with. */
type RequestError = string | ReturnType<typeof createChainHaltedError>;

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
  | { kind: 'consumerSent'; connectionId: string; request: JsonRpcRequest; consumer: Consumer }
  // No state handles it: a send the frame took changes nothing, and only ends the work `await()` counts.
  | { kind: 'sendAnswered'; connectionId: string }
  | { kind: 'sendFailed'; connectionId: string; request: JsonRpcRequest; error: unknown }
  | { kind: 'disconnected'; connectionId: string };

type ChainsEffect =
  | { kind: 'connect'; connectionId: string; genesisHash: string; signal: AbortSignal }
  | { kind: 'send'; connectionId: string; request: JsonRpcRequest }
  | { kind: 'leave'; leave: AbortController }
  | { kind: 'deliver'; consumer: Consumer; message: JsonRpcMessage }
  | { kind: 'answer'; consumer: Consumer; request: JsonRpcRequest; error: RequestError }
  | { kind: 'halt'; consumer: Consumer; reason: RemoteChainHalt }
  | { kind: 'messageUnparsed'; connectionId: string; error: unknown }
  | { kind: 'connectErrored'; error: unknown }
  | { kind: 'sendErrored'; error: unknown };

type ChainsMachine = MachineTypes<ChainsState, ChainsEvent, ChainsEffect>;

type ConnectionMachine = MachineTypes<Connection, ChainsEvent, ChainsEffect>;

const { chain } = protocolSchema.sections;

/** Connections to the frame's chains, each request on `rpc`. */
export function createRemoteChains({ rpc }: Params) {
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
    emitSideEffect({ kind: 'deliver', consumer, message: parsed });
  };

  // A clean end is the chain halting. An error is a refusal, a connect that ran out of budget or never found the frame
  // up, or a frame that went down, and halts like a dead frame so a caching consumer drops it.
  const endChain: HandlerOf<ConnectionMachine, 'connecting' | 'connected', 'chainEnded'> = (
    connection,
    { error },
    transition,
  ) => {
    if (error !== null && connection.kind === 'connecting') {
      transition.emitSideEffect({ kind: 'connectErrored', error });
    }
    haltConnection(connection, error === null ? 'chain' : 'frame', transition);
  };

  // Leaving aborts the connect, or the subscription once it is up, as a disconnect, so its trail still ends. A connect
  // still queued is never sent, one the frame has is closed there, and one the frame is not up for never goes out.
  const leaveChain: HandlerOf<ConnectionMachine, 'connecting' | 'connected', 'disconnected'> = (
    { leave },
    _event,
    { emitState, emitSideEffect },
  ) => {
    emitState({ kind: 'closed' });
    emitSideEffect({ kind: 'leave', leave });
  };

  const handleConnection = nest<
    ChainsMachine,
    'open',
    ConnectionMachine,
    'chainConnected' | 'chainMessage' | 'chainEnded' | 'consumerSent' | 'sendFailed' | 'disconnected'
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
        chainConnected({ consumer, pending, leave }, { connectionId }, { emitState, emitSideEffect }) {
          emitState({ kind: 'connected', consumer, leave });
          for (const request of pending) {
            emitSideEffect({ kind: 'send', connectionId, request });
          }
        },
        chainMessage: deliverMessage,
        chainEnded: endChain,
        consumerSent(connection, { request }, { emitState }) {
          emitState({ ...connection, pending: [...connection.pending, request] });
        },
        disconnected: leaveChain,
      },
      connected: {
        chainMessage: deliverMessage,
        chainEnded: endChain,
        consumerSent(_connection, { connectionId, request }, { emitSideEffect }) {
          emitSideEffect({ kind: 'send', connectionId, request });
        },
        // A refusal reaches the consumer as the answer to its request.
        sendFailed({ consumer }, { request, error }, { emitSideEffect }) {
          emitSideEffect({ kind: 'sendErrored', error });
          emitSideEffect({ kind: 'answer', consumer, request, error: serializeError(error) });
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
        opened(state, { connectionId, genesisHash, consumer }, { emitState, emitSideEffect }) {
          const leave = new AbortController();
          const connecting: Connection = { kind: 'connecting', consumer, pending: [], leave };
          emitState({ ...state, connections: new Map(state.connections).set(connectionId, connecting) });
          emitSideEffect({ kind: 'connect', connectionId, genesisHash, signal: leave.signal });
        },
        chainConnected: handleConnection,
        chainMessage: handleConnection,
        chainEnded: handleConnection,
        consumerSent(state, event, transition) {
          if (!state.connections.has(event.connectionId)) {
            const { consumer, request } = event;
            transition.emitSideEffect({ kind: 'answer', consumer, request, error: 'Chain connection is closed' });
            return;
          }
          handleConnection(state, event, transition);
        },
        sendFailed: handleConnection,
        disconnected: handleConnection,
      },
    },
    onEffect: runEffect,
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

    return (onMessage, onHalt) => {
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
    };
  }

  return {
    /**
     * A provider of connections to the chain of `genesisHash` in the frame, or null when the frame cannot connect this
     * chain.
     */
    createProvider,
  };

  function runEffect(effect: ChainsEffect): void {
    switch (effect.kind) {
      case 'connect':
        connectChain(effect);
        return;
      case 'send': {
        const { connectionId, request } = effect;
        chains.update(
          rpc.request(chain.send, { connectionId, message: JSON.stringify(request) }).then(
            (): ChainsEvent => ({ kind: 'sendAnswered', connectionId }),
            (error: unknown): ChainsEvent => ({ kind: 'sendFailed', connectionId, request, error }),
          ),
        );
        return;
      }
      case 'leave':
        effect.leave.abort(setErrorName(new Error('Chain disconnected'), 'ChainDisconnectedError'));
        return;
      case 'deliver': {
        const { consumer, message } = effect;
        guardConsumer('message', () => {
          consumer.onMessage(message);
        });
        return;
      }
      case 'answer': {
        const { consumer, request, error } = effect;
        // A notification has no `id` to answer.
        if (request.id === undefined || request.id === null) {
          return;
        }
        const message = createJsonRpcError(request.id, error);
        guardConsumer('message', () => {
          consumer.onMessage(message);
        });
        return;
      }
      case 'halt': {
        const { consumer, reason } = effect;
        guardConsumer('halt', () => {
          consumer.onHalt?.(reason);
        });
        return;
      }
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
  }

  /**
   * Subscribes the chain once the frame is ready, and tells its messages and its end as events. The connect has its own
   * budget, and running out of it unsubscribes, which disconnects a connection a busy frame may still accept.
   */
  function connectChain({ connectionId, genesisHash, signal }: Extract<ChainsEffect, { kind: 'connect' }>): void {
    chains.update(
      rpc.call(chain.connect, subscribeChain, { signal }).then(
        (): ChainsEvent => ({ kind: 'chainConnected', connectionId }),
        (error: unknown): ChainsEvent => ({ kind: 'chainEnded', connectionId, error: toError(error) }),
      ),
    );

    // Resolves once the frame accepts the connection. A second resolve or reject does nothing, so no listener reads the
    // connection's phase.
    function subscribeChain(transport: ProtocolTransport, budget: AbortSignal): Promise<void> {
      return new Promise((resolve, reject) => {
        subscribe({
          transport,
          method: chain.connect,
          start: { genesisHash, connectionId },
          listeners: {
            receive: event => {
              if (event.tag === 'message') {
                chains.update({ kind: 'chainMessage', connectionId, message: event.value });
                return;
              }
              resolve();
            },
            end: error => {
              reject(error ?? new Error('Chain halted before it connected'));
              chains.update({ kind: 'chainEnded', connectionId, error });
            },
          },
          signal: budget,
        });
      });
    }
  }
}

/** A consumer callback that throws is reported, not propagated, so the other consumers still hear the halt. */
function guardConsumer(label: 'halt' | 'message', call: () => void): void {
  try {
    call();
  } catch (error: unknown) {
    report.listener(`remote_chain.${label}`)(error);
  }
}

/**
 * Closes the connection, answers every unsent request as `reason` says, then tells the consumer of the halt. Closed
 * first, so a send made during the halt is answered at once, not queued and lost.
 */
function haltConnection(
  connection: Exclude<Connection, { kind: 'closed' }>,
  reason: RemoteChainHalt,
  { emitState, emitSideEffect }: Transition<ConnectionMachine>,
): void {
  emitState({ kind: 'closed' });
  const { consumer } = connection;
  if (connection.kind === 'connecting') {
    // A chain halt is retryable, unlike the dead frame's plain close.
    const error = reason === 'chain' ? createChainHaltedError() : 'Chain connection is closed';
    for (const request of connection.pending) {
      emitSideEffect({ kind: 'answer', consumer, request, error });
    }
  }
  emitSideEffect({ kind: 'halt', consumer, reason });
}
