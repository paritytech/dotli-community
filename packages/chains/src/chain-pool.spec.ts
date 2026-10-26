// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { must } from '@dotli/shared/testing';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
import type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from '@polkadot-api/json-rpc-provider';
import type { ChainTransportHooks } from './transport-hooks.js';
import { bindLogSink } from '@dotli/shared';
import { createChainPool, type ChainActivity, type ChainPool, type ChainPoolWatcher } from './chain-pool.js';
import { headerHex } from './testing/header-hex.js';

type TransportRecord = {
  genesisHash: string;
  hooks: ChainTransportHooks;
  sent: JsonRpcRequest[];
  emit: (message: JsonRpcMessage) => void;
  disconnect: Mock<() => void>;
  opened: number;
};

/** A pool factory that records every transport it builds, per chain. */
function createTransports(supported: (genesisHash: string) => boolean = () => true): {
  createTransport: (genesisHash: string, hooks: ChainTransportHooks) => JsonRpcProvider | null;
  built: TransportRecord[];
} {
  const built: TransportRecord[] = [];
  const createTransport = (genesisHash: string, hooks: ChainTransportHooks): JsonRpcProvider | null => {
    if (!supported(genesisHash)) {
      return null;
    }
    let listener: ((message: JsonRpcMessage) => void) | null = null;
    const record: TransportRecord = {
      genesisHash,
      hooks,
      sent: [],
      emit(message) {
        listener?.(message);
      },
      disconnect: vi.fn<() => void>(),
      opened: 0,
    };
    built.push(record);
    return (onMessage): JsonRpcConnection => {
      listener = onMessage;
      record.opened += 1;
      return {
        send(message) {
          record.sent.push(message);
        },
        disconnect: record.disconnect,
      };
    };
  };
  return { createTransport, built };
}

function lease(
  pool: ChainPool,
  genesisHash: string,
  onMessage: (message: JsonRpcMessage) => void = () => undefined,
  onHalt?: (error?: unknown) => void,
): JsonRpcConnection {
  return must(pool.getLocalProvider(genesisHash), `provider for ${genesisHash}`)(onMessage, onHalt);
}

describe('createChainPool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('As a dotli integrator, I lease one chain twice and share one transport, and each chain gets its own', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport });

    // When
    lease(pool, '0xAA');
    lease(pool, '0xaa');
    lease(pool, '0xbb');

    // Then
    expect(built.map(record => record.genesisHash)).toEqual(['0xaa', '0xbb']);
    expect(built.map(record => record.opened)).toEqual([1, 1]);
  });

  it('As a dotli integrator, I release the last lease and the chain closes destroyDelay later, unless a new lease arrives first', async () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: 1_000 });
    const first = lease(pool, '0xaa');

    // When
    first.disconnect();
    await vi.advanceTimersByTimeAsync(999);
    const second = lease(pool, '0xaa');
    await vi.advanceTimersByTimeAsync(5_000);

    // Then
    expect(built).toHaveLength(1);
    expect(must(built[0], 'transport').disconnect).not.toHaveBeenCalled();
    expect(pool.status('0xaa')).toBe('connecting');

    // When
    second.disconnect();
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    expect(must(built[0], 'transport').disconnect).toHaveBeenCalledTimes(1);
    expect(pool.status('0xaa')).toBe('disconnected');
  });

  it('As a dotli integrator, I release the last lease under an infinite destroyDelay and the chain is kept', async () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: Infinity });

    // When
    lease(pool, '0xaa').disconnect();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    lease(pool, '0xaa');

    // Then
    expect(built).toHaveLength(1);
    expect(must(built[0], 'transport').disconnect).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, I add a throwing status listener and it is reported, stops no other listener and never reaches the transport', () => {
    // Given
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const errors: string[] = [];
    onTestFinished(
      bindLogSink({
        emit: (level, message) => {
          if (level === 'error') {
            errors.push(message);
          }
        },
      }),
    );
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport });
    lease(pool, '0xaa');
    const seen: string[] = [];
    pool.onStatusChanged('0xaa', () => {
      throw new Error('listener bug');
    });
    pool.onStatusChanged('0xaa', status => {
      seen.push(status);
    });

    // When
    const report = (): void => {
      must(built[0], 'transport').hooks.onStatus('connected');
    };

    // Then
    expect(report).not.toThrow();
    expect(seen).toEqual(['connected']);
    expect(captured).toEqual([{ flow: 'protocol', step: 'listener', tags: { owner: 'chain_pool.status' } }]);
    expect(errors).toHaveLength(captured.length);
    expect(metrics.counted('listener.delivery')).toEqual([
      { outcome: 'error', reason: 'Error', owner: 'chain_pool.status' },
    ]);
  });

  it('As a dotli integrator, I take a provider and never call it, and its chain is not kept', async () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: 1_000 });

    // When
    pool.getLocalProvider('0xaa');
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    expect(pool.status('0xaa')).toBe('disconnected');
    expect(must(built[0], 'transport').opened).toBe(0);
  });

  it('As a dotli integrator, I hold leases on a transport that halts, each lease ends once and my next lease rebuilds the chain', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: 0 });
    const haltA = vi.fn();
    const haltB = vi.fn();
    lease(pool, '0xaa', undefined, haltA);
    lease(pool, '0xaa', undefined, haltB);
    const failure = new Error('chain stopped responding');

    // When
    must(built[0], 'transport').hooks.onHalt(failure);
    must(built[0], 'transport').hooks.onHalt(failure);

    // Then
    expect(haltA).toHaveBeenCalledTimes(1);
    expect(haltA).toHaveBeenCalledWith(failure);
    expect(haltB).toHaveBeenCalledTimes(1);
    expect(must(built[0], 'transport').disconnect).toHaveBeenCalledTimes(1);
    expect(pool.status('0xaa')).toBe('disconnected');

    // When
    lease(pool, '0xaa');

    // Then
    expect(built).toHaveLength(2);
  });

  it('As a dotli integrator, I release a lease after its chain was rebuilt and the new connection is left alone', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: 0 });
    const stale = lease(pool, '0xaa');
    must(built[0], 'transport').hooks.onHalt(new Error('gone'));
    lease(pool, '0xaa');

    // When
    stale.disconnect();
    stale.disconnect();

    // Then
    expect(must(built[1], 'transport').disconnect).not.toHaveBeenCalled();
    expect(pool.status('0xaa')).toBe('connecting');
  });

  it('As a dotli integrator, I read each chain status from the pool and a closed transport changes nothing', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: 0 });
    const seen: string[] = [];
    pool.onStatusChanged('0xaa', status => {
      seen.push(status);
    });

    // When
    const connection = lease(pool, '0xaa');
    must(built[0], 'transport').hooks.onStatus('connected');
    connection.disconnect();
    must(built[0], 'transport').hooks.onStatus('connected');

    // Then
    expect(pool.status('0xbb')).toBe('disconnected');
    expect(seen).toEqual(['connecting', 'connected', 'disconnected']);
    expect(pool.status('0xaa')).toBe('disconnected');
  });

  it('As a dotli integrator, I ask for a chain the factory cannot reach and nothing is built', () => {
    // Given
    const { createTransport, built } = createTransports(genesisHash => genesisHash !== '0xbb');
    const pool = createChainPool({ createTransport });

    // When
    const local = pool.getLocalProvider('0xbb');
    const remote = pool.connectRemote('0xbb', 'conn-1', () => undefined);

    // Then
    expect(local).toBeNull();
    expect(remote).toBeNull();
    expect(built).toHaveLength(0);
    expect(pool.status('0xbb')).toBe('disconnected');
  });

  it('As a dotli integrator, I connect remotely and hold a lease, and a duplicate connection id leaks none', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: 0 });
    const remote = must(
      pool.connectRemote('0xaa', 'conn-1', () => undefined),
      'remote connection',
    );

    // When
    expect(() => pool.connectRemote('0xaa', 'conn-1', () => undefined)).toThrow('Duplicate broker session');
    remote.disconnect();

    // Then
    expect(must(built[0], 'transport').disconnect).toHaveBeenCalledTimes(1);
    expect(pool.status('0xaa')).toBe('disconnected');
  });

  it('As a dotli integrator, I disconnect all and every chain closes without halting its leases', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport });
    const onHalt = vi.fn();
    lease(pool, '0xaa', undefined, onHalt);
    lease(pool, '0xbb', undefined, onHalt);

    // When
    pool.disconnectAll();

    // Then
    expect(built.map(record => record.disconnect.mock.calls.length)).toEqual([1, 1]);
    expect(onHalt).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, I watch a transaction and hear it dropped when the transport disconnects', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport });
    const received: JsonRpcMessage[] = [];
    const connection = lease(pool, '0xaa', message => {
      received.push(message);
    });
    connection.send({ jsonrpc: '2.0', id: 1, method: 'transactionWatch_v1_submitAndWatch', params: ['0xdead'] });
    const transport = must(built[0], 'transport');
    const upstream = must(transport.sent[0], 'upstream submit');
    transport.emit({ jsonrpc: '2.0', id: must(upstream.id, 'upstream id'), result: 'watch-1' });
    const ack = must(received[0], 'submit response') as { id: unknown; result: unknown };
    received.length = 0;

    // When
    transport.hooks.onStatus('disconnected');

    // Then
    expect(ack.id).toBe(1);
    expect(received).toEqual([
      {
        jsonrpc: '2.0',
        method: 'transactionWatch_v1_watchEvent',
        params: { subscription: ack.result, result: { event: 'dropped' } },
      },
    ]);
  });

  it('As a dotli integrator, I watch a transaction on a transport that disconnects and then halts, and hear it dropped before the halt', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport });
    const events: string[] = [];
    const connection = lease(
      pool,
      '0xaa',
      message => {
        const event = (message as { params?: { result?: { event?: string } } }).params?.result?.event;
        events.push(event ?? 'response');
      },
      () => {
        events.push('halt');
      },
    );
    connection.send({ jsonrpc: '2.0', id: 1, method: 'transactionWatch_v1_submitAndWatch', params: ['0xdead'] });
    const transport = must(built[0], 'transport');
    transport.emit({
      jsonrpc: '2.0',
      id: must(must(transport.sent[0], 'upstream submit').id, 'id'),
      result: 'watch-1',
    });
    events.length = 0;

    // When
    transport.hooks.onStatus('disconnected');
    transport.hooks.onHalt(new Error('gone'));

    // Then
    expect(events).toEqual(['dropped', 'halt']);
  });

  it('As a dotli integrator, I rebuild a chain from a halt handler and it reports its own status', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: 0 });
    const seen: string[] = [];
    pool.onStatusChanged('0xaa', status => {
      seen.push(status);
    });
    lease(pool, '0xaa', undefined, () => {
      lease(pool, '0xaa');
    });

    // When
    must(built[0], 'transport').hooks.onHalt(new Error('gone'));

    // Then
    expect(built).toHaveLength(2);
    expect(pool.status('0xaa')).toBe('connecting');
    expect(seen).toEqual(['connecting', 'disconnected', 'connecting']);
  });

  it('As a dotli integrator, I connect remotely under a name like a local lease and the two do not collide', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport });
    const remote = must(
      pool.connectRemote('0xaa', 'local:0', () => undefined),
      'remote connection',
    );

    // When
    const local = lease(pool, '0xaa');
    local.send({ jsonrpc: '2.0', id: 1, method: 'chainSpec_v1_genesisHash', params: [] });
    remote.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'chainSpec_v1_genesisHash', params: [] }));

    // Then
    expect(must(built[0], 'transport').sent).toHaveLength(2);
  });
});

describe('createChainPool warnings', () => {
  /** Collects the warnings logged while `run` runs, then puts back the sink bound before. */
  function warningsDuring(run: () => void): string[] {
    const warnings: string[] = [];
    const restore = bindLogSink({
      emit: (level, message) => {
        if (level === 'warn') {
          warnings.push(message);
        }
      },
    });
    try {
      run();
    } finally {
      restore();
    }
    return warnings;
  }

  function strayResponses(transport: TransportRecord, from: number, to: number): void {
    for (let id = from; id < to; id++) {
      transport.emit({ jsonrpc: '2.0', id: `stray-${String(id)}`, result: null });
    }
  }

  it('As a dotli maintainer, I see a chain that halts and is rebuilt keep counting its anomalies, so a flapping chain cannot flood the trail', () => {
    // Given a chain whose broker already logged an anomaly past its full logging, and which then halted
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: 0 });
    lease(pool, '0xaa');
    warningsDuring(() => {
      strayResponses(must(built[0], 'first transport'), 0, 5);
    });
    must(built[0], 'first transport').hooks.onHalt(new Error('gone'));

    // When the chain is leased again and its rebuilt broker hits the same anomaly
    lease(pool, '0xaa');
    const warnings = warningsDuring(() => {
      strayResponses(must(built[1], 'rebuilt transport'), 5, 10);
    });

    // Then the rebuilt broker continues the count instead of logging its first few again
    expect(warnings).toEqual([expect.stringMatching(/^\[dot\.li broker\] \w+: 10 so far$/) as string]);
  });
});

describe('createChainPool watch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function recorder(): { watcher: ChainPoolWatcher; activity: ChainActivity[]; best: [string, number][] } {
    const activity: ChainActivity[] = [];
    const best: [string, number][] = [];
    return {
      watcher: {
        onActivity: next => {
          activity.push(next);
        },
        onBestBlock: (genesisHash, blockNumber) => {
          best.push([genesisHash, blockNumber]);
        },
      },
      activity,
      best,
    };
  }

  it('As the network panel, I watch and no chain is built, and none is kept past its destroy delay', async () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: 1_000 });
    const seen = recorder();

    // When
    pool.watch(seen.watcher);

    // Then
    expect(built).toEqual([]);
    expect(seen.activity).toEqual([]);

    // When
    lease(pool, '0xaa').disconnect();
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    expect(must(built[0], 'transport').disconnect).toHaveBeenCalledTimes(1);
    expect(seen.activity.at(-1)).toEqual({
      genesisHash: '0xaa',
      consumers: 0,
      status: 'disconnected',
      following: false,
    });
  });

  it('As the network panel, I hear each lease, release and status change', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: Infinity });
    const seen = recorder();
    pool.watch(seen.watcher);

    // When
    const first = lease(pool, '0xAA');
    must(built[0], 'transport').hooks.onStatus('connected');
    first.disconnect();

    // Then
    expect(seen.activity.map(a => [a.genesisHash, a.consumers, a.status])).toEqual([
      ['0xaa', 0, 'connecting'],
      ['0xaa', 1, 'connecting'],
      ['0xaa', 1, 'connected'],
      ['0xaa', 0, 'connected'],
    ]);
  });

  it('As the network panel opening late, I hear every chain already held', () => {
    // Given
    const pool = createChainPool({ createTransport: createTransports().createTransport });
    lease(pool, '0xaa');
    const seen = recorder();

    // When
    pool.watch(seen.watcher);

    // Then
    expect(seen.activity).toEqual([{ genesisHash: '0xaa', consumers: 1, status: 'connecting', following: false }]);
  });

  it('As the network panel, I end on the rebuilt chain when a chain is rebuilt inside its halt, not on the dead one', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: Infinity });
    const seen = recorder();
    pool.watch(seen.watcher);
    lease(
      pool,
      '0xaa',
      () => undefined,
      () => {
        lease(pool, '0xaa');
      },
    );

    // When
    must(built[0], 'transport').hooks.onHalt(new Error('gone'));

    // Then
    expect(built).toHaveLength(2);
    expect(seen.activity.at(-1)).toMatchObject({ genesisHash: '0xaa', consumers: 1 });
  });

  it('As a dotli integrator, I add a throwing watcher and it is reported, keeping neither the others nor the pool from the change', () => {
    // Given
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const errors: string[] = [];
    onTestFinished(
      bindLogSink({
        emit: (level, message) => {
          if (level === 'error') {
            errors.push(message);
          }
        },
      }),
    );
    const pool = createChainPool({ createTransport: createTransports().createTransport });
    pool.watch({
      onActivity: () => {
        throw new Error('panel bug');
      },
      onBestBlock: () => undefined,
    });
    const seen = recorder();
    pool.watch(seen.watcher);

    // When
    const connection = lease(pool, '0xaa');

    // Then the throwing panel is reported once for each of the two activity changes a first lease makes
    expect(seen.activity.at(-1)).toMatchObject({ consumers: 1 });
    expect(connection).toBeDefined();
    expect(captured).toEqual(
      Array(2).fill({ flow: 'protocol', step: 'listener', tags: { owner: 'chain_pool.watch' } }),
    );
    expect(errors).toHaveLength(2);
    expect(metrics.counted('listener.delivery')).toEqual(
      Array(2).fill({ outcome: 'error', reason: 'Error', owner: 'chain_pool.watch' }),
    );
  });

  const isFollow = (message: JsonRpcRequest): boolean => message.method === 'chainHead_v1_follow';

  /** Answers the pool's newest follow request upstream and returns its upstream event emitter. */
  function answerFollow(record: TransportRecord, upstreamToken: string): (result: Record<string, unknown>) => void {
    const request = must(record.sent.filter(isFollow).at(-1), 'follow request');
    record.emit({ jsonrpc: '2.0', id: must(request.id, 'follow id'), result: upstreamToken } as JsonRpcMessage);
    return result => {
      record.emit({
        jsonrpc: '2.0',
        method: 'chainHead_v1_followEvent',
        params: { subscription: upstreamToken, result },
      } as unknown as JsonRpcMessage);
    };
  }

  /** Answers the pool's newest header request upstream with a header numbered `blockNumber`. */
  function answerHeader(record: TransportRecord, blockNumber: number): void {
    const request = must(record.sent.filter(message => message.method === 'chainHead_v1_header').at(-1), 'header');
    record.emit({
      jsonrpc: '2.0',
      id: must(request.id, 'header id'),
      result: headerHex(blockNumber),
    } as JsonRpcMessage);
  }

  it('As the network panel, I get the best blocks of a chain someone holds without following it', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: Infinity });
    const seen = recorder();
    pool.watch(seen.watcher);

    // When
    lease(pool, '0xaa');
    const transport = must(built[0], 'transport');
    const event = answerFollow(transport, 'up-1');
    event({ event: 'initialized', finalizedBlockHashes: ['0xf0'] });
    event({ event: 'newBlock', blockHash: '0xb1', parentBlockHash: '0xf0' });
    event({ event: 'bestBlockChanged', bestBlockHash: '0xb1' });
    answerHeader(transport, 8);

    // Then
    expect(transport.sent.filter(isFollow).map(message => message.params as unknown)).toEqual([[true]]);
    expect(transport.sent.at(-1)).toMatchObject({ method: 'chainHead_v1_header', params: ['up-1', '0xb1'] });
    expect(seen.activity.at(-1)).toMatchObject({ genesisHash: '0xaa', consumers: 1, following: true });
    expect(seen.best).toEqual([['0xaa', 8]]);
  });

  it('As the network panel opening after a consumer follows with the runtime, I join its follow and get its best block', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: Infinity });
    const connection = lease(pool, '0xaa');
    const transport = must(built[0], 'transport');
    connection.send({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] });
    const event = answerFollow(transport, 'up-1');
    event({ event: 'initialized', finalizedBlockHashes: ['0xf0'] });
    event({ event: 'bestBlockChanged', bestBlockHash: '0xf0' });
    const seen = recorder();

    // When
    pool.watch(seen.watcher);
    answerHeader(transport, 7);

    // Then
    expect(transport.sent.filter(isFollow)).toHaveLength(1);
    expect(seen.activity.at(-1)).toMatchObject({ genesisHash: '0xaa', consumers: 1, following: true });
    expect(seen.best).toEqual([['0xaa', 7]]);
  });

  it('As the network panel, I have my follow stopped by the last consumer leaving before I hear no consumers are left', async () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: 1_000 });
    const seen = recorder();
    pool.watch(seen.watcher);
    const connection = lease(pool, '0xaa');
    const transport = must(built[0], 'transport');
    answerFollow(transport, 'up-1')({ event: 'initialized', finalizedBlockHashes: ['0xf0'] });

    // When
    connection.disconnect();

    // Then
    expect(transport.sent.at(-1)).toMatchObject({ method: 'chainHead_v1_unfollow', params: ['up-1'] });
    expect(seen.activity.find(activity => activity.consumers === 0)).toMatchObject({ following: false });

    // When
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    expect(transport.disconnect).toHaveBeenCalledTimes(1);
  });

  it('As a consumer following with the runtime, I share the network panel follow rather than open another', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: Infinity });
    pool.watch(recorder().watcher);
    const replies: JsonRpcMessage[] = [];
    const connection = lease(pool, '0xaa', message => {
      replies.push(message);
    });
    const transport = must(built[0], 'transport');
    answerFollow(transport, 'up-1')({ event: 'initialized', finalizedBlockHashes: ['0xf0'] });

    // When
    connection.send({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] });

    // Then
    expect(transport.sent.filter(isFollow)).toHaveLength(1);
    expect(replies.some(reply => 'id' in reply && reply.id === 1 && 'result' in reply)).toBe(true);
  });

  it('As the network panel, I have a follow the chain stops started again while the chain is held', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: Infinity });
    pool.watch(recorder().watcher);
    lease(pool, '0xaa');
    const transport = must(built[0], 'transport');
    const event = answerFollow(transport, 'up-1');

    // When
    event({ event: 'stop' });

    // Then
    expect(transport.sent.filter(isFollow)).toHaveLength(2);
  });

  it('As a dotli integrator, I leave a pool unwatched and it follows nothing of its own, and the last unwatch ends its follows', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: Infinity });
    lease(pool, '0xaa');
    const transport = must(built[0], 'transport');

    // Then
    expect(transport.sent.filter(isFollow)).toEqual([]);

    // When
    const unwatch = pool.watch(recorder().watcher);
    answerFollow(transport, 'up-1')({ event: 'initialized', finalizedBlockHashes: ['0xf0'] });
    unwatch();

    // Then
    expect(transport.sent.at(-1)).toMatchObject({ method: 'chainHead_v1_unfollow', params: ['up-1'] });
  });

  it('As the network panel, I unwatch and the reports stop', () => {
    // Given
    const pool = createChainPool({ createTransport: createTransports().createTransport });
    const seen = recorder();
    const unwatch = pool.watch(seen.watcher);

    // When
    unwatch();
    lease(pool, '0xaa');

    // Then
    expect(seen.activity).toEqual([]);
  });
});
