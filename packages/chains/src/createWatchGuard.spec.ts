// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from '@polkadot-api/json-rpc-provider';
import { createWatchGuard } from './createWatchGuard.js';

function createTransport(): {
  transport: JsonRpcProvider;
  sent: JsonRpcRequest[];
  emit: (message: JsonRpcMessage) => void;
  disconnect: ReturnType<typeof vi.fn>;
} {
  const sent: JsonRpcRequest[] = [];
  const disconnect = vi.fn();
  let listener: ((message: JsonRpcMessage) => void) | null = null;
  function connectTransport(onMessage: (message: JsonRpcMessage) => void): JsonRpcConnection {
    listener = onMessage;
    return {
      send(message) {
        sent.push(message);
      },
      disconnect,
    };
  }
  return {
    transport: connectTransport,
    sent,
    emit(message) {
      listener?.(message);
    },
    disconnect,
  };
}

function createSubmitRequest(id: number): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method: 'transactionWatch_v1_submitAndWatch', params: ['0xdead'] };
}

function createWatchEvent(subscription: string, event: string): JsonRpcMessage {
  return {
    jsonrpc: '2.0',
    method: 'transactionWatch_v1_watchEvent',
    params: { subscription, result: { event } },
  };
}

function createDroppedEvent(subscription: string): JsonRpcMessage {
  return createWatchEvent(subscription, 'dropped');
}

describe('createWatchGuard', () => {
  it('As a dotli integrator, I disconnect and hear no drop for a watch that already ended or was unwatched', () => {
    // Given
    const { transport, emit } = createTransport();
    const guard = createWatchGuard({ transport });
    const received: JsonRpcMessage[] = [];
    const connection = guard.provider(message => {
      received.push(message);
    });
    connection.send(createSubmitRequest(1));
    emit({ jsonrpc: '2.0', id: 1, result: 'watch-1' });
    connection.send(createSubmitRequest(2));
    emit({ jsonrpc: '2.0', id: 2, result: 'watch-2' });
    emit(createWatchEvent('watch-1', 'finalized'));
    connection.send({ jsonrpc: '2.0', id: 3, method: 'transactionWatch_v1_unwatch', params: ['watch-2'] });
    received.length = 0;

    // When
    guard.onStatus('disconnected');

    // Then
    expect(received).toEqual([]);
  });

  it('As a dotli integrator, I hear my watches dropped only on a disconnect, and only once', () => {
    // Given
    const { transport, emit } = createTransport();
    const guard = createWatchGuard({ transport });
    const received: JsonRpcMessage[] = [];
    const connection = guard.provider(message => {
      received.push(message);
    });
    connection.send(createSubmitRequest(1));
    emit({ jsonrpc: '2.0', id: 1, result: 'watch-1' });
    received.length = 0;

    // When
    guard.onStatus('connecting');
    guard.onStatus('connected');

    // Then
    expect(received).toEqual([]);

    // When
    guard.onStatus('disconnected');
    guard.onStatus('disconnected');

    // Then
    expect(received).toEqual([createDroppedEvent('watch-1')]);
  });

  it('As a dotli integrator, I leave a watch still unanswered at a disconnect to the proxy, and it is tracked once answered', () => {
    // Given the proxy re-sends an unanswered request after a reconnect
    const { transport, emit } = createTransport();
    const guard = createWatchGuard({ transport });
    const received: JsonRpcMessage[] = [];
    const connection = guard.provider(message => {
      received.push(message);
    });
    connection.send(createSubmitRequest(1));

    // When
    guard.onStatus('disconnected');

    // Then
    expect(received).toEqual([]);

    // When the re-sent submit is answered on the new socket, which then drops too
    emit({ jsonrpc: '2.0', id: 1, result: 'watch-1' });
    received.length = 0;
    guard.onStatus('disconnected');

    // Then
    expect(received).toEqual([createDroppedEvent('watch-1')]);
  });

  it('As a dotli integrator, I send and hear other traffic through the guard untouched', () => {
    // Given
    const { transport, sent, emit } = createTransport();
    const guard = createWatchGuard({ transport });
    const received: JsonRpcMessage[] = [];
    const connection = guard.provider(message => {
      received.push(message);
    });
    const subscribe: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 'a',
      method: 'statement_subscribeStatement',
      params: [{ matchAll: [] }],
    };
    const notification: JsonRpcMessage = {
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: { subscription: 's-1', result: { event: 'newStatements', data: { statements: ['0x01'], remaining: 0 } } },
    };

    // When
    connection.send(subscribe);
    emit({ jsonrpc: '2.0', id: 'a', result: 's-1' });
    emit(notification);
    guard.onStatus('disconnected');

    // Then
    expect(sent).toEqual([subscribe]);
    expect(received).toEqual([{ jsonrpc: '2.0', id: 'a', result: 's-1' }, notification]);
  });

  it('As a dotli integrator, I disconnect the guard and it forgets its watches and closes the transport', () => {
    // Given
    const { transport, emit, disconnect } = createTransport();
    const guard = createWatchGuard({ transport });
    const received: JsonRpcMessage[] = [];
    const connection = guard.provider(message => {
      received.push(message);
    });
    connection.send(createSubmitRequest(1));
    emit({ jsonrpc: '2.0', id: 1, result: 'watch-1' });
    received.length = 0;

    // When
    connection.disconnect();
    guard.onStatus('disconnected');

    // Then
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(received).toEqual([]);
  });
});
