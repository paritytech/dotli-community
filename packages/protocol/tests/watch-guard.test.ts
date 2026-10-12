// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from '@polkadot-api/json-rpc-provider';
import { createWatchGuard } from '../src/watch-guard.js';

function createTransport(): {
  transport: JsonRpcProvider;
  sent: JsonRpcRequest[];
  emit: (message: JsonRpcMessage) => void;
  disconnect: ReturnType<typeof vi.fn>;
} {
  const sent: JsonRpcRequest[] = [];
  const disconnect = vi.fn();
  let listener: ((message: JsonRpcMessage) => void) | null = null;
  const transport: JsonRpcProvider = (onMessage): JsonRpcConnection => {
    listener = onMessage;
    return {
      send(message) {
        sent.push(message);
      },
      disconnect,
    };
  };
  return {
    transport,
    sent,
    emit(message) {
      listener?.(message);
    },
    disconnect,
  };
}

function submit(id: number): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method: 'transactionWatch_v1_submitAndWatch', params: ['0xdead'] };
}

function watchEvent(subscription: string, event: string): JsonRpcMessage {
  return {
    jsonrpc: '2.0',
    method: 'transactionWatch_v1_watchEvent',
    params: { subscription, result: { event } },
  };
}

function dropped(subscription: string): JsonRpcMessage {
  return watchEvent(subscription, 'dropped');
}

describe('createWatchGuard', () => {
  it('As a dotli integrator, a transaction watch the transport loses on a disconnect ends with dropped', () => {
    // Given
    const { transport, emit } = createTransport();
    const guard = createWatchGuard(transport);
    const received: JsonRpcMessage[] = [];
    const connection = guard.provider(message => {
      received.push(message);
    });
    connection.send(submit(1));
    emit({ jsonrpc: '2.0', id: 1, result: 'watch-1' });
    received.length = 0;

    // When
    guard.onStatus('disconnected');

    // Then
    expect(received).toEqual([dropped('watch-1')]);
  });

  it('As a dotli integrator, a watch that already ended or was unwatched is not dropped again', () => {
    // Given
    const { transport, emit } = createTransport();
    const guard = createWatchGuard(transport);
    const received: JsonRpcMessage[] = [];
    const connection = guard.provider(message => {
      received.push(message);
    });
    connection.send(submit(1));
    emit({ jsonrpc: '2.0', id: 1, result: 'watch-1' });
    connection.send(submit(2));
    emit({ jsonrpc: '2.0', id: 2, result: 'watch-2' });
    emit(watchEvent('watch-1', 'finalized'));
    connection.send({ jsonrpc: '2.0', id: 3, method: 'transactionWatch_v1_unwatch', params: ['watch-2'] });
    received.length = 0;

    // When
    guard.onStatus('disconnected');

    // Then
    expect(received).toEqual([]);
  });

  it('As a dotli integrator, only a disconnect drops watches, and only once', () => {
    // Given
    const { transport, emit } = createTransport();
    const guard = createWatchGuard(transport);
    const received: JsonRpcMessage[] = [];
    const connection = guard.provider(message => {
      received.push(message);
    });
    connection.send(submit(1));
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
    expect(received).toEqual([dropped('watch-1')]);
  });

  it('As a dotli integrator, a watch still unanswered at a disconnect is left to the proxy, and tracked once answered', () => {
    // Given: the proxy re-sends an unanswered request after a reconnect.
    const { transport, emit } = createTransport();
    const guard = createWatchGuard(transport);
    const received: JsonRpcMessage[] = [];
    const connection = guard.provider(message => {
      received.push(message);
    });
    connection.send(submit(1));

    // When
    guard.onStatus('disconnected');

    // Then
    expect(received).toEqual([]);

    // When: the re-sent submit is answered on the new socket, which then drops too.
    emit({ jsonrpc: '2.0', id: 1, result: 'watch-1' });
    received.length = 0;
    guard.onStatus('disconnected');

    // Then
    expect(received).toEqual([dropped('watch-1')]);
  });

  it('As a dotli integrator, other traffic passes through the guard untouched', () => {
    // Given
    const { transport, sent, emit } = createTransport();
    const guard = createWatchGuard(transport);
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

  it('As a dotli integrator, disconnecting the guard forgets its watches and closes the transport', () => {
    // Given
    const { transport, emit, disconnect } = createTransport();
    const guard = createWatchGuard(transport);
    const received: JsonRpcMessage[] = [];
    const connection = guard.provider(message => {
      received.push(message);
    });
    connection.send(submit(1));
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
