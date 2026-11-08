// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { catchError } from '@dotli/shared/testing';
import type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from '@polkadot-api/json-rpc-provider';
import { createPausableTransport, type PausableTransport } from './createPausableTransport.js';

type FakeConnection = {
  /** What the wrapper sent on this transport connection, in order. */
  readonly sent: JsonRpcRequest[];
  /** How often the wrapper closed it. */
  disconnects: number;
  /** Delivers a transport message on this connection. */
  emit(message: JsonRpcMessage): void;
};

function createFakeTransport(): { transport: JsonRpcProvider; opened: FakeConnection[] } {
  const opened: FakeConnection[] = [];
  function transport(onMessage: (message: JsonRpcMessage) => void): JsonRpcConnection {
    const connection: FakeConnection = { sent: [], disconnects: 0, emit: onMessage };
    opened.push(connection);
    return {
      send(message) {
        connection.sent.push(message);
      },
      disconnect() {
        connection.disconnects += 1;
      },
    };
  }
  return { transport, opened };
}

/** A transport whose `call`th connection runs `action` first, then opens as usual. */
function createTransportWithActionOnCall(
  call: number,
  action: () => void,
): { transport: JsonRpcProvider; opened: FakeConnection[] } {
  const { transport, opened } = createFakeTransport();
  let calls = 0;
  function acting(onMessage: (message: JsonRpcMessage) => void): JsonRpcConnection {
    calls += 1;
    if (calls === call) {
      action();
    }
    return transport(onMessage);
  }
  return { transport: acting, opened };
}

function setup(): {
  pausable: PausableTransport;
  opened: FakeConnection[];
  received: JsonRpcMessage[];
  consumer: JsonRpcConnection;
} {
  const { transport, opened } = createFakeTransport();
  const pausable = createPausableTransport({ transport });
  const received: JsonRpcMessage[] = [];
  const consumer = pausable.provider(message => {
    received.push(message);
  });
  return { pausable, opened, received, consumer };
}

function request(id: number, method: string, params: unknown[] = []): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, params };
}

function answer(id: number, result: unknown): JsonRpcMessage {
  return { jsonrpc: '2.0', id, result };
}

function stopEvent(subscription: string): JsonRpcMessage {
  return {
    jsonrpc: '2.0',
    method: 'chainHead_v1_followEvent',
    params: { subscription, result: { event: 'stop' } },
  };
}

function connection(opened: FakeConnection[], index: number): FakeConnection {
  const found = opened[index];
  if (found === undefined) {
    throw new Error(`No transport connection ${String(index)} among ${String(opened.length)}`);
  }
  return found;
}

describe('createPausableTransport', () => {
  it('As a chain consumer, my messages pass through untouched while nothing is paused', () => {
    // Given
    const { opened, received, consumer } = setup();
    const message = request(1, 'system_health');

    // When
    consumer.send(message);
    connection(opened, 0).emit(answer(1, { peers: 3 }));

    // Then
    expect(connection(opened, 0).sent).toEqual([message]);
    expect(received).toEqual([answer(1, { peers: 3 })]);
  });

  it('As a chain consumer following a chain, a pause stops my follow and fails my chainHead call in flight', () => {
    // Given
    const { pausable, opened, received, consumer } = setup();
    consumer.send(request(1, 'chainHead_v1_follow', [true]));
    connection(opened, 0).emit(answer(1, 'f1'));
    consumer.send(request(7, 'chainHead_v1_call', ['f1', '0x01', 'Core_version', '0x']));

    // When
    pausable.pause();

    // Then
    expect(received).toEqual([
      answer(1, 'f1'),
      stopEvent('f1'),
      { jsonrpc: '2.0', id: 7, error: { code: -32603, message: 'Internal error' } },
    ]);
    expect(connection(opened, 0).disconnects).toBe(1);
  });

  it('As a chain consumer releasing a block or a follow at a pause, my release is answered as done', () => {
    // Given
    const { pausable, opened, received, consumer } = setup();
    consumer.send(request(1, 'chainHead_v1_follow', [true]));
    connection(opened, 0).emit(answer(1, 'f1'));
    consumer.send(request(9, 'chainHead_v1_unpin', ['f1', ['0x01']]));
    consumer.send(request(10, 'chainHead_v1_unfollow', ['f1']));

    // When
    pausable.pause();

    // Then
    expect(received).toEqual([
      answer(1, 'f1'),
      { jsonrpc: '2.0', id: 9, result: null },
      { jsonrpc: '2.0', id: 10, result: null },
    ]);
  });

  it('As a chain consumer whose follow is still unanswered at a pause, I get one answer after the chain resumes', () => {
    // Given
    const { pausable, opened, received, consumer } = setup();
    consumer.send(request(3, 'chainHead_v1_follow', [true]));
    pausable.pause();

    // When
    pausable.resume();
    connection(opened, 1).emit(answer(3, 'f2'));

    // Then
    expect(connection(opened, 1).sent).toEqual([request(3, 'chainHead_v1_follow', [true])]);
    expect(received).toEqual([answer(3, 'f2')]);
  });

  it('As a chain consumer who follows again inside the stop, my new follow is held and goes out once on resume', () => {
    // Given
    const { transport, opened } = createFakeTransport();
    const pausable = createPausableTransport({ transport });
    const consumer: JsonRpcConnection = pausable.provider(message => {
      if ('method' in message && message.method === 'chainHead_v1_followEvent') {
        consumer.send(request(2, 'chainHead_v1_follow', [true]));
      }
    });
    consumer.send(request(1, 'chainHead_v1_follow', [true]));
    connection(opened, 0).emit(answer(1, 'f1'));

    // When
    pausable.pause();
    pausable.resume();

    // Then
    expect(connection(opened, 0).sent).toEqual([request(1, 'chainHead_v1_follow', [true])]);
    expect(connection(opened, 1).sent).toEqual([request(2, 'chainHead_v1_follow', [true])]);
  });

  it('As a chain consumer, a request in flight and a send made while paused go out once the chain resumes', () => {
    // Given
    const { pausable, opened, consumer } = setup();
    consumer.send(request(4, 'chain_getHeader'));
    pausable.pause();
    consumer.send(request(5, 'system_health'));
    const openedWhilePaused = opened.length;

    // When
    pausable.resume();

    // Then
    expect(openedWhilePaused).toBe(1);
    expect(connection(opened, 0).sent).toEqual([request(4, 'chain_getHeader')]);
    expect(connection(opened, 1).sent).toEqual([request(4, 'chain_getHeader'), request(5, 'system_health')]);
  });

  it('As a chain consumer whose broadcast stop is in flight at a pause, my stop is answered as done and never resent', () => {
    // Given
    const { pausable, opened, received, consumer } = setup();
    consumer.send(request(1, 'transaction_v1_broadcast', ['0xdead']));
    connection(opened, 0).emit(answer(1, 'op1'));
    consumer.send(request(2, 'transaction_v1_stop', ['op1']));

    // When
    pausable.pause();
    pausable.resume();

    // Then
    expect(received).toEqual([answer(1, 'op1'), { jsonrpc: '2.0', id: 2, result: null }]);
    expect(connection(opened, 1).sent).toEqual([]);
  });

  it('As a chain consumer stopping a broadcast the closed connection answered, my stop is answered at once', () => {
    // Given
    const { pausable, opened, received, consumer } = setup();
    consumer.send(request(1, 'transaction_v1_broadcast', ['0xdead']));
    connection(opened, 0).emit(answer(1, 'op1'));
    pausable.pause();

    // When
    consumer.send(request(2, 'transaction_v1_stop', ['op1']));
    const receivedWhilePaused = [...received];
    pausable.resume();

    // Then
    expect(receivedWhilePaused).toEqual([answer(1, 'op1'), { jsonrpc: '2.0', id: 2, result: null }]);
    expect(connection(opened, 1).sent).toEqual([]);
  });

  it('As a chain consumer releasing an id the new connection issued again, my release goes out', () => {
    // Given
    const { pausable, opened, consumer } = setup();
    consumer.send(request(1, 'chainHead_v1_follow', [true]));
    connection(opened, 0).emit(answer(1, 'f1'));
    pausable.pause();
    pausable.resume();
    consumer.send(request(2, 'chainHead_v1_follow', [true]));
    connection(opened, 1).emit(answer(2, 'f1'));

    // When
    consumer.send(request(3, 'chainHead_v1_unfollow', ['f1']));

    // Then
    expect(connection(opened, 1).sent).toEqual([
      request(2, 'chainHead_v1_follow', [true]),
      request(3, 'chainHead_v1_unfollow', ['f1']),
    ]);
  });

  it('As a chain consumer releasing a follow the pause stopped, my unfollow is answered at once', () => {
    // Given
    const { pausable, opened, received, consumer } = setup();
    consumer.send(request(1, 'chainHead_v1_follow', [true]));
    connection(opened, 0).emit(answer(1, 'f1'));
    consumer.send(request(2, 'chainHead_v1_follow', [true]));
    connection(opened, 0).emit(answer(2, 'f2'));
    pausable.pause();

    // When
    consumer.send(request(3, 'chainHead_v1_unfollow', ['f1']));
    pausable.resume();
    consumer.send(request(4, 'chainHead_v1_unfollow', ['f2']));

    // Then
    expect(received).toEqual([
      answer(1, 'f1'),
      answer(2, 'f2'),
      stopEvent('f1'),
      stopEvent('f2'),
      { jsonrpc: '2.0', id: 3, result: null },
      { jsonrpc: '2.0', id: 4, result: null },
    ]);
    expect(connection(opened, 1).sent).toEqual([]);
  });

  it('As a chain consumer, a block header answer is not noted as an opened id', () => {
    // Given
    const { pausable, opened, consumer } = setup();
    consumer.send(request(1, 'chainHead_v1_header', ['f0', '0x01']));
    connection(opened, 0).emit(answer(1, '0xab'));
    pausable.pause();
    pausable.resume();

    // When
    consumer.send(request(2, 'chainHead_v1_unpin', ['0xab']));

    // Then
    expect(connection(opened, 1).sent).toEqual([request(2, 'chainHead_v1_unpin', ['0xab'])]);
  });

  it('As a chain consumer with a statement subscription, I keep my subscription id across a pause', () => {
    // Given
    const { pausable, opened, received, consumer } = setup();
    consumer.send(request(1, 'statement_subscribeStatement', ['any']));
    connection(opened, 0).emit(answer(1, 's1'));
    pausable.pause();

    // When
    pausable.resume();
    connection(opened, 1).emit(answer(1, 's2'));
    connection(opened, 1).emit({
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: { subscription: 's2', result: '0xbeef' },
    });

    // Then
    expect(connection(opened, 1).sent).toEqual([request(1, 'statement_subscribeStatement', ['any'])]);
    expect(received).toEqual([
      answer(1, 's1'),
      { jsonrpc: '2.0', method: 'statement_statement', params: { subscription: 's1', result: '0xbeef' } },
    ]);
  });

  it('As a chain consumer, pausing or resuming twice closes and opens my connection once', () => {
    // Given
    const { pausable, opened } = setup();

    // When
    pausable.pause();
    pausable.pause();
    const pausedAfterPauses = pausable.isPaused();
    pausable.resume();
    pausable.resume();

    // Then
    expect(pausedAfterPauses).toBe(true);
    expect(pausable.isPaused()).toBe(false);
    expect(opened).toHaveLength(2);
    expect(connection(opened, 0).disconnects).toBe(1);
    expect(connection(opened, 1).disconnects).toBe(0);
  });

  it('As a chain consumer who connects while paused, my connection opens only on resume', () => {
    // Given
    const { transport, opened } = createFakeTransport();
    const pausable = createPausableTransport({ transport });
    pausable.pause();
    const consumer = pausable.provider(() => undefined);
    consumer.send(request(1, 'system_health'));
    const openedWhilePaused = opened.length;

    // When
    pausable.resume();

    // Then
    expect(openedWhilePaused).toBe(0);
    expect(opened).toHaveLength(1);
    expect(connection(opened, 0).sent).toEqual([request(1, 'system_health')]);
  });

  it('As a chain consumer who leaves while paused, nothing reopens on resume', () => {
    // Given
    const { pausable, opened, consumer } = setup();
    consumer.send(request(1, 'system_health'));
    pausable.pause();
    consumer.send(request(2, 'system_health'));

    // When
    consumer.disconnect();
    pausable.resume();

    // Then
    expect(opened).toHaveLength(1);
    expect(connection(opened, 0).disconnects).toBe(1);
  });

  it('As a chain consumer, a late message from the closed connection never reaches me', () => {
    // Given
    const { pausable, opened, received } = setup();
    pausable.pause();
    pausable.resume();

    // When
    connection(opened, 0).emit(answer(1, 'late'));

    // Then
    expect(received).toEqual([]);
  });

  it('As a chain consumer on a transport that fails to close, I still hear my follow stop and my chainHead call fail before the pause throws', () => {
    // Given
    const { transport, opened } = createFakeTransport();
    const closeError = new Error('close failed');
    function failingTransport(onMessage: (message: JsonRpcMessage) => void): JsonRpcConnection {
      const inner = transport(onMessage);
      return {
        send: inner.send,
        disconnect() {
          inner.disconnect();
          throw closeError;
        },
      };
    }
    const pausable = createPausableTransport({ transport: failingTransport });
    const received: JsonRpcMessage[] = [];
    const consumer = pausable.provider(message => {
      received.push(message);
    });
    consumer.send(request(1, 'chainHead_v1_follow', [true]));
    connection(opened, 0).emit(answer(1, 'f1'));
    consumer.send(request(7, 'chainHead_v1_call', ['f1', '0x01', 'Core_version', '0x']));

    // When
    const error = catchError(() => {
      pausable.pause();
    });

    // Then
    expect(error).toBe(closeError);
    expect(received).toEqual([
      answer(1, 'f1'),
      stopEvent('f1'),
      { jsonrpc: '2.0', id: 7, error: { code: -32603, message: 'Internal error' } },
    ]);
    expect(pausable.isPaused()).toBe(true);
  });

  it('As a chain consumer beside one whose reopen fails, my held request still goes out, and theirs goes out on the next resume', () => {
    // Given two consumers, and a transport that throws when the first one reopens
    const reopenError = new Error('reopen failed');
    const { transport, opened } = createTransportWithActionOnCall(3, () => {
      throw reopenError;
    });
    const pausable = createPausableTransport({ transport });
    const failing = pausable.provider(() => undefined);
    const other = pausable.provider(() => undefined);
    pausable.pause();
    failing.send(request(1, 'system_health'));
    other.send(request(2, 'system_health'));

    // When
    const error = catchError(() => {
      pausable.resume();
    });

    // Then the other consumer's request goes out and the reopen's error is thrown
    expect(error).toBe(reopenError);
    expect(connection(opened, 2).sent).toEqual([request(2, 'system_health')]);
    expect(opened).toHaveLength(3);

    // When
    pausable.pause();
    pausable.resume();

    // Then the failing consumer kept its request and sends it once it reopens
    expect(connection(opened, 3).sent).toEqual([request(1, 'system_health')]);
  });

  it('As a chain consumer whose reopen failed, I resume again and my held request goes out', () => {
    // Given a transport that throws when the consumer reopens, and a resume that failed
    const reopenError = new Error('reopen failed');
    const { transport, opened } = createTransportWithActionOnCall(2, () => {
      throw reopenError;
    });
    const pausable = createPausableTransport({ transport });
    const consumer = pausable.provider(() => undefined);
    pausable.pause();
    consumer.send(request(1, 'system_health'));
    const error = catchError(() => {
      pausable.resume();
    });

    // When
    pausable.resume();

    // Then
    expect(error).toBe(reopenError);
    expect(opened).toHaveLength(2);
    expect(connection(opened, 1).sent).toEqual([request(1, 'system_health')]);
  });

  it('As a chain consumer who leaves while my connection reopens, nothing is sent and the new connection is closed', () => {
    // Given a transport whose reopen lets the consumer leave before it returns
    let consumer: JsonRpcConnection | null = null;
    const { transport, opened } = createTransportWithActionOnCall(2, () => {
      consumer?.disconnect();
    });
    const pausable = createPausableTransport({ transport });
    consumer = pausable.provider(() => undefined);
    pausable.pause();
    consumer.send(request(1, 'system_health'));

    // When
    pausable.resume();

    // Then
    expect(connection(opened, 1).sent).toEqual([]);
    expect(connection(opened, 1).disconnects).toBe(1);
  });
});
