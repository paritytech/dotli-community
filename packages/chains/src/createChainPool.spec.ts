// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { catchError, must } from '@dotli/shared/testing';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';
import type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from '@polkadot-api/json-rpc-provider';
import { CHAIN_HEAD_FOLLOW } from './jsonRpcMethods.js';
import { RPC_FOLLOW_LIMIT, type ChainTransport, type ChainTransportHooks } from './transportHooks.js';
import { ChainHaltError } from './chainHaltError.js';
import { bindLogSink } from '@dotli/shared';
import { createChainPool, type ChainActivity, type ChainPool, type ChainPoolWatcher } from './createChainPool.js';
import { collectWarningsDuring } from './testing/collectWarningsDuring.js';
import { encodeHeaderHex } from './testing/encodeHeaderHex.js';

type TransportRecord = {
  genesisHash: string;
  hooks: ChainTransportHooks;
  sent: JsonRpcRequest[];
  emit: (message: JsonRpcMessage) => void;
  disconnect: Mock<() => void>;
  opened: number;
};

type TransportsParams = {
  /** Whether the factory reaches a chain. Every chain by default. */
  supported?: (genesisHash: string) => boolean;
  /** The follow limit each transport states. */
  followLimit?: number;
};

/** A pool factory that records every transport it builds, one per connection. */
function createTransports({ supported = () => true, followLimit = Infinity }: TransportsParams = {}): {
  createTransport: (genesisHash: string, hooks: ChainTransportHooks) => ChainTransport | null;
  built: TransportRecord[];
} {
  const built: TransportRecord[] = [];
  function createTransport(genesisHash: string, hooks: ChainTransportHooks): ChainTransport | null {
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
    const provider: JsonRpcProvider = (onMessage): JsonRpcConnection => {
      listener = onMessage;
      record.opened += 1;
      return {
        send(message) {
          record.sent.push(message);
        },
        disconnect: record.disconnect,
      };
    };
    return { provider, followLimit };
  }
  return { createTransport, built };
}

/** Builds transports as `createTransports` does, except that `failing`'s transport throws on every open after its first. */
function createReopenFailingTransports(failing: string): {
  createTransport: (genesisHash: string, hooks: ChainTransportHooks) => ChainTransport | null;
  built: TransportRecord[];
} {
  const { createTransport: createBase, built } = createTransports();
  function createTransport(genesisHash: string, hooks: ChainTransportHooks): ChainTransport | null {
    const base = createBase(genesisHash, hooks);
    if (base === null || genesisHash !== failing) {
      return base;
    }
    let opens = 0;
    const provider: JsonRpcProvider = onMessage => {
      opens += 1;
      if (opens > 1) {
        throw new Error('reopen failed');
      }
      return base.provider(onMessage);
    };
    return { provider, followLimit: base.followLimit };
  }
  return { createTransport, built };
}

/** Builds transports as `createTransports` does, except that the first one halts as its connection opens. */
function createHaltOnOpenTransports(): {
  createTransport: (genesisHash: string, hooks: ChainTransportHooks) => ChainTransport | null;
  built: TransportRecord[];
} {
  const { createTransport: createBase, built } = createTransports();
  function createTransport(genesisHash: string, hooks: ChainTransportHooks): ChainTransport | null {
    const base = createBase(genesisHash, hooks);
    if (base === null || built.length > 1) {
      return base;
    }
    const provider: JsonRpcProvider = onMessage => {
      const connection = base.provider(onMessage);
      hooks.onHalt(new Error('gone while opening'));
      return connection;
    };
    return { provider, followLimit: base.followLimit };
  }
  return { createTransport, built };
}

/** Takes a healing lease through the pool's local provider, failing the test when the pool has no provider for it. */
function lease(
  pool: ChainPool,
  genesisHash: string,
  { onMessage = () => undefined }: { onMessage?: (message: JsonRpcMessage) => void } = {},
): JsonRpcConnection {
  return must(pool.getLocalProvider(genesisHash), `provider for ${genesisHash}`)(onMessage);
}

let remoteLeases = 0;

/**
 * Leases a chain for a remote session under a fresh id, which ends at its chain's halt, with its JSON text read as
 * messages. Fails the test when the pool cannot reach the chain.
 */
function remoteLease(
  pool: ChainPool,
  genesisHash: string,
  {
    onMessage = () => undefined,
    onHalt,
  }: { onMessage?: (message: JsonRpcMessage) => void; onHalt: (error?: unknown) => void },
): JsonRpcConnection {
  const connectionId = `lease-${String(remoteLeases)}`;
  remoteLeases += 1;
  const connection = must(
    pool.connectRemote({
      genesisHash,
      connectionId,
      onMessage: message => {
        // The string wire carries JSON-RPC messages as text.
        onMessage(JSON.parse(message) as JsonRpcMessage);
      },
      onHalt,
    }),
    `remote session on ${genesisHash}`,
  );
  return {
    send: message => {
      connection.send(JSON.stringify(message));
    },
    disconnect: connection.disconnect,
  };
}

/** The requests of `method` a connection sent the node, in order. */
function listMethod(record: TransportRecord, method: string): JsonRpcRequest[] {
  return record.sent.filter(message => message.method === method);
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
    remoteLease(pool, '0xaa', { onHalt: haltA });
    remoteLease(pool, '0xaa', { onHalt: haltB });
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

  it('As a dotli integrator, I release a lease after its chain was rebuilt and neither the new connection nor the watchers hear of it', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: 0 });
    const stale = remoteLease(pool, '0xaa', { onHalt: () => undefined });
    must(built[0], 'transport').hooks.onHalt(new Error('gone'));
    lease(pool, '0xaa');
    const activity: ChainActivity[] = [];
    pool.watch({
      onActivity: next => {
        activity.push(next);
      },
      onBestBlock: () => undefined,
    });
    const heardBefore = activity.length;

    // When
    stale.disconnect();
    stale.disconnect();

    // Then
    expect(must(built[1], 'transport').disconnect).not.toHaveBeenCalled();
    expect(pool.status('0xaa')).toBe('connecting');
    expect(activity.slice(heardBefore)).toEqual([]);
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
    const { createTransport, built } = createTransports({ supported: genesisHash => genesisHash !== '0xbb' });
    const pool = createChainPool({ createTransport });

    // When
    const local = pool.getLocalProvider('0xbb');
    const remote = pool.connectRemote({ genesisHash: '0xbb', connectionId: 'conn-1', onMessage: () => undefined });

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
      pool.connectRemote({ genesisHash: '0xaa', connectionId: 'conn-1', onMessage: () => undefined }),
      'remote connection',
    );

    // When
    const duplicate = catchError(() =>
      pool.connectRemote({ genesisHash: '0xaa', connectionId: 'conn-1', onMessage: () => undefined }),
    );
    remote.disconnect();

    // Then
    // An asymmetric matcher is typed any.
    expect(duplicate).toMatchObject({ message: expect.stringContaining('Duplicate 0xaa… consumer') as string });
    expect(must(built[0], 'transport').disconnect).toHaveBeenCalledTimes(1);
    expect(pool.status('0xaa')).toBe('disconnected');
  });

  it('As a dotli integrator, I disconnect all and every chain closes without halting its leases', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport });
    const onHalt = vi.fn();
    remoteLease(pool, '0xaa', { onHalt });
    remoteLease(pool, '0xbb', { onHalt });

    // When
    pool.disconnectAll();

    // Then
    expect(built.map(record => record.disconnect.mock.calls.length)).toEqual([1, 1]);
    expect(onHalt).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, I disconnect all while one chain fails to close and every other chain still closes', () => {
    // Given two chains, the first of which throws when its transport closes
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const errors: string[] = [];
    onTestFinished(
      bindLogSink({
        emit: ({ level, message }) => {
          if (level === 'error') {
            errors.push(message);
          }
        },
      }),
    );
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport });
    lease(pool, '0xaa');
    lease(pool, '0xbb');
    must(built[0], 'transport').disconnect.mockImplementation(() => {
      throw new Error('close failed');
    });

    // When every chain is disconnected
    const error = catchError(() => {
      pool.disconnectAll();
    });

    // Then nothing throws, both transports were asked to close and the failure is reported once
    expect(error).toBeUndefined();
    expect(built.map(record => record.disconnect.mock.calls.length)).toEqual([1, 1]);
    expect(pool.status('0xbb')).toBe('disconnected');
    expect(captured).toMatchObject([{ step: 'chain_pool_close' }]);
    expect(errors).toHaveLength(captured.length);
    expect(metrics.counted('chain_pool.close')).toEqual([{ outcome: 'error', reason: 'Error' }]);
  });

  it('As a dotli integrator, I release a chain whose transport fails to close and the idle timer closes it without throwing', async () => {
    // Given a released chain whose transport throws when it closes
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    onTestFinished(bindLogSink({ emit: () => undefined }));
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: 1_000 });
    const held = lease(pool, '0xaa');
    must(built[0], 'transport').disconnect.mockImplementation(() => {
      throw new Error('close failed');
    });
    held.disconnect();

    // When the destroy delay passes
    await vi.advanceTimersByTimeAsync(1_000);

    // Then the chain is disconnected and the close failure is reported
    expect(pool.status('0xaa')).toBe('disconnected');
    expect(metrics.counted('chain_pool.close')).toEqual([{ outcome: 'error', reason: 'Error' }]);
  });

  it("As a dotli integrator, I see a chain's transport halt while it fails to close and the halt still reaches its lease", () => {
    // Given a leased chain whose transport throws when it closes
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    onTestFinished(bindLogSink({ emit: () => undefined }));
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport });
    const onHalt = vi.fn();
    remoteLease(pool, '0xaa', { onHalt });
    must(built[0], 'transport').disconnect.mockImplementation(() => {
      throw new Error('close failed');
    });

    // When the transport halts
    const error = catchError(() => {
      must(built[0], 'transport').hooks.onHalt(new Error('gone'));
    });

    // Then the halt reaches the lease, nothing throws and the close failure is reported
    expect(error).toBeUndefined();
    expect(onHalt).toHaveBeenCalledTimes(1);
    expect(pool.status('0xaa')).toBe('disconnected');
    expect(metrics.counted('chain_pool.close')).toEqual([{ outcome: 'error', reason: 'Error' }]);
  });

  it('As a dotli integrator, I watch a transaction on a transport that disconnects and then halts, and hear it dropped before the halt', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport });
    const events: string[] = [];
    const connection = remoteLease(pool, '0xaa', {
      onMessage: message => {
        // A response has no params, so only a notification names an event.
        const event = (message as { params?: { result?: { event?: string } } }).params?.result?.event;
        events.push(event ?? 'response');
      },
      onHalt: () => {
        events.push('halt');
      },
    });
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
    remoteLease(pool, '0xaa', {
      onHalt: () => {
        lease(pool, '0xaa');
      },
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
      pool.connectRemote({ genesisHash: '0xaa', connectionId: 'local:0', onMessage: () => undefined }),
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
  /** Answers, on the transport, the requests numbered `from` up to `to` that nobody sent. */
  function emitStrayResponses(transport: TransportRecord, { from, to }: { from: number; to: number }): void {
    for (let id = from; id < to; id++) {
      transport.emit({ jsonrpc: '2.0', id: `stray-${String(id)}`, result: null });
    }
  }

  it('As a dotli maintainer, I see a chain that halts and is rebuilt keep counting its anomalies, so a flapping chain cannot flood the trail', () => {
    // Given a chain whose broker already logged an anomaly past its full logging, and which then halted
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: 0 });
    lease(pool, '0xaa');
    collectWarningsDuring(() => {
      emitStrayResponses(must(built[0], 'first transport'), { from: 0, to: 5 });
    });
    must(built[0], 'first transport').hooks.onHalt(new Error('gone'));

    // When the chain is leased again and its rebuilt broker hits the same anomaly
    lease(pool, '0xaa');
    const warnings = collectWarningsDuring(() => {
      emitStrayResponses(must(built[1], 'rebuilt transport'), { from: 5, to: 10 });
    });

    // Then the rebuilt broker continues the count instead of logging its first few again
    // An asymmetric matcher is typed any.
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

  function createRecorder(): { watcher: ChainPoolWatcher; activity: ChainActivity[]; best: [string, number][] } {
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
    const seen = createRecorder();

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
    const seen = createRecorder();
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
    const seen = createRecorder();

    // When
    pool.watch(seen.watcher);

    // Then
    expect(seen.activity).toEqual([{ genesisHash: '0xaa', consumers: 1, status: 'connecting', following: false }]);
  });

  it('As the network panel, I end on the rebuilt chain when a chain is rebuilt inside its halt, not on the dead one', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: Infinity });
    const seen = createRecorder();
    pool.watch(seen.watcher);
    remoteLease(pool, '0xaa', {
      onHalt: () => {
        lease(pool, '0xaa');
      },
    });

    // When
    must(built[0], 'transport').hooks.onHalt(new Error('gone'));

    // Then
    expect(built).toHaveLength(2);
    expect(seen.activity.at(-1)).toMatchObject({ genesisHash: '0xaa', consumers: 1 });
  });

  function isFollow(message: JsonRpcRequest): boolean {
    return message.method === 'chainHead_v1_follow';
  }

  /** Answers the pool's newest follow request upstream and returns its upstream event emitter. */
  function answerFollow(record: TransportRecord, upstreamToken: string): (result: Record<string, unknown>) => void {
    const request = must(record.sent.filter(isFollow).at(-1), 'follow request');
    record.emit({ jsonrpc: '2.0', id: must(request.id, 'follow id'), result: upstreamToken });
    return result => {
      record.emit({
        jsonrpc: '2.0',
        method: 'chainHead_v1_followEvent',
        params: { subscription: upstreamToken, result },
      });
    };
  }

  /** Answers the pool's newest header request upstream with a header numbered `blockNumber`. */
  function answerHeader(record: TransportRecord, blockNumber: number): void {
    const request = must(record.sent.filter(message => message.method === 'chainHead_v1_header').at(-1), 'header');
    record.emit({
      jsonrpc: '2.0',
      id: must(request.id, 'header id'),
      result: encodeHeaderHex(blockNumber),
    });
  }

  it('As the network panel, I get the best blocks of a chain someone holds without following it', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: Infinity });
    const seen = createRecorder();
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
    expect(transport.sent.filter(isFollow).map((message): unknown => message.params)).toEqual([[true]]);
    expect(transport.sent.at(-1)).toMatchObject({ method: 'chainHead_v1_header', params: ['up-1', '0xb1'] });
    expect(seen.activity.at(-1)).toMatchObject({ genesisHash: '0xaa', consumers: 1, following: true });
    expect(seen.best).toEqual([['0xaa', 8]]);
  });

  it('As the network panel, I have my follow stopped by the last consumer leaving before I hear no consumers are left', async () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: 1_000 });
    const seen = createRecorder();
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

  /** Refuses the pool's newest follow request upstream, as a node at its follow limit does. */
  function refuseFollow(record: TransportRecord): void {
    const request = must(record.sent.filter(isFollow).at(-1), 'follow request');
    record.emit({ jsonrpc: '2.0', id: must(request.id, 'follow id'), error: { code: -32800, message: 'limit' } });
  }

  it('As the network panel, my follow on a held chain is refused and I follow it again after the backoff', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: Infinity });
    pool.watch(createRecorder().watcher);
    lease(pool, '0xaa');
    const transport = must(built[0], 'transport');
    refuseFollow(transport);

    // When
    vi.advanceTimersByTime(0);
    const afterFirstRetry = transport.sent.filter(isFollow).length;
    refuseFollow(transport);
    vi.advanceTimersByTime(999);
    const beforeBackoffEnds = transport.sent.filter(isFollow).length;
    vi.advanceTimersByTime(1);

    // Then
    expect(afterFirstRetry).toBe(2);
    expect(beforeBackoffEnds).toBe(2);
    expect(transport.sent.filter(isFollow)).toHaveLength(3);
  });

  it('As the network panel, I have my follow stopped by the chain and then refused, and I follow it again after the backoff', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: Infinity });
    pool.watch(createRecorder().watcher);
    lease(pool, '0xaa');
    const transport = must(built[0], 'transport');
    answerFollow(transport, 'up-1')({ event: 'stop' });

    // When
    refuseFollow(transport);
    vi.advanceTimersByTime(0);

    // Then
    expect(transport.sent.filter(isFollow)).toHaveLength(3);
  });

  it('As the network panel, I see my chain released and leased again while its refused follow waits, and I follow it only once the backoff ends', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: Infinity });
    pool.watch(createRecorder().watcher);
    const connection = lease(pool, '0xaa');
    const transport = must(built[0], 'transport');
    refuseFollow(transport);
    vi.advanceTimersByTime(0);
    refuseFollow(transport);

    // When
    connection.disconnect();
    lease(pool, '0xaa');
    vi.advanceTimersByTime(999);
    const beforeBackoffEnds = transport.sent.filter(isFollow).length;
    vi.advanceTimersByTime(1);

    // Then
    expect(beforeBackoffEnds).toBe(2);
    expect(transport.sent.filter(isFollow)).toHaveLength(3);
  });

  it('As the network panel, I have my follow refused on a chain released before its retry, and I open no follow', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: Infinity });
    pool.watch(createRecorder().watcher);
    const connection = lease(pool, '0xaa');
    const transport = must(built[0], 'transport');
    refuseFollow(transport);

    // When
    connection.disconnect();
    const timersLeft = vi.getTimerCount();
    vi.advanceTimersByTime(30_000);

    // Then
    expect(timersLeft).toBe(0);
    expect(transport.sent.filter(isFollow)).toHaveLength(1);
  });

  it('As the network panel, I have my refused follow wait on a chain that halts, and I do not retry it on the dead chain', () => {
    // Given a remote session, so nothing rebuilds the chain and opens a follow of its own
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: Infinity });
    pool.watch(createRecorder().watcher);
    remoteLease(pool, '0xaa', { onHalt: vi.fn<(error?: unknown) => void>() });
    const transport = must(built[0], 'transport');
    refuseFollow(transport);

    // When
    transport.hooks.onHalt(new Error('gone'));
    const timersLeft = vi.getTimerCount();
    vi.advanceTimersByTime(30_000);

    // Then
    expect(timersLeft).toBe(0);
    expect(transport.sent.filter(isFollow)).toHaveLength(1);
  });

  it('As the network panel, I unwatch while my follow opens a new connection and no follow is sent on it', () => {
    // Given a first follow that was refused, and the only connection's follow room taken by a remote session
    const { createTransport, built } = createTransports({ followLimit: 1 });
    const pool = createChainPool({ createTransport, destroyDelay: Infinity });
    let unwatch: (() => void) | null = null;
    unwatch = pool.watch({
      onActivity: () => {
        unwatch?.();
      },
      onBestBlock: () => undefined,
    });
    const first = unwatch;
    unwatch = null;
    remoteLease(pool, '0xaa', { onHalt: vi.fn<(error?: unknown) => void>() });
    const transport = must(built[0], 'transport');
    refuseFollow(transport);
    transport.hooks.onStatus('connected');
    const remote = remoteLease(pool, '0xaa', { onHalt: vi.fn<(error?: unknown) => void>() });
    remote.send({ jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] });
    unwatch = first;

    // When the retry opens its follow on a new connection, and the status change that opens it reaches the panel
    vi.advanceTimersByTime(0);

    // Then the panel's unwatch left the new connection with no follow
    const opened = must(built[1], 'second connection');
    expect(listMethod(opened, 'chainHead_v1_follow')).toEqual([]);
  });

  it('As the network panel, I see my chain leased, released and leased again, and I open its follow at once each time', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: Infinity });
    pool.watch(createRecorder().watcher);
    const connection = lease(pool, '0xaa');
    const transport = must(built[0], 'transport');
    answerFollow(transport, 'up-1');

    // When
    connection.disconnect();
    lease(pool, '0xaa');

    // Then
    expect(transport.sent.filter(isFollow)).toHaveLength(2);
  });

  it('As a dotli integrator, I leave a pool unwatched and it follows nothing of its own, and the last unwatch ends its follows', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: Infinity });

    // When
    lease(pool, '0xaa');
    const transport = must(built[0], 'transport');

    // Then
    expect(transport.sent.filter(isFollow)).toEqual([]);

    // When
    const unwatch = pool.watch(createRecorder().watcher);
    answerFollow(transport, 'up-1')({ event: 'initialized', finalizedBlockHashes: ['0xf0'] });
    unwatch();

    // Then
    expect(transport.sent.at(-1)).toMatchObject({ method: 'chainHead_v1_unfollow', params: ['up-1'] });
  });

  it('As the network panel, I unwatch and the reports stop', () => {
    // Given
    const pool = createChainPool({ createTransport: createTransports().createTransport });
    const seen = createRecorder();
    const unwatch = pool.watch(seen.watcher);

    // When
    unwatch();
    lease(pool, '0xaa');

    // Then
    expect(seen.activity).toEqual([]);
  });

  it('As the network panel, I watch a chain that cannot open a connection for my follow, and get my unwatch while that chain halts and the next is followed', () => {
    // Given 0xaa's one connection full of its leases' follows, no second connection to it, and 0xbb held
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    onTestFinished(bindLogSink({ emit: () => undefined }));
    let builds = 0;
    const { createTransport, built } = createTransports({
      followLimit: RPC_FOLLOW_LIMIT,
      supported: genesisHash => {
        if (genesisHash !== '0xaa') {
          return true;
        }
        builds += 1;
        return builds === 1;
      },
    });
    const pool = createChainPool({ createTransport, destroyDelay: Infinity });
    const halts: unknown[] = [];
    for (let index = 0; index < RPC_FOLLOW_LIMIT; index += 1) {
      const connection = remoteLease(pool, '0xaa', {
        onHalt: error => {
          halts.push(error);
        },
      });
      connection.send({ jsonrpc: '2.0', id: index, method: CHAIN_HEAD_FOLLOW, params: [true] });
    }
    lease(pool, '0xbb');

    // When the network panel watches
    const unwatch = pool.watch(createRecorder().watcher);

    // Then the watch returns its unwatch, 0xaa's lane is reported and the chain halts every lease, and 0xbb is followed
    expect(unwatch).toBeTypeOf('function');
    expect(captured).toMatchObject([{ step: 'chain_lane_build' }]);
    expect(metrics.counted('chain_pool.lane_open')).toEqual([{ outcome: 'error', reason: 'Error' }]);
    expect(pool.status('0xaa')).toBe('disconnected');
    expect(halts).toHaveLength(RPC_FOLLOW_LIMIT);
    const other = must(
      built.find(record => record.genesisHash === '0xbb'),
      '0xbb transport',
    );
    expect(listMethod(other, CHAIN_HEAD_FOLLOW)).toHaveLength(1);
  });

  it('As the network panel, I watch a chain whose new connection throws as it opens, and get my unwatch with the chain still live', () => {
    // Given 0xaa's one connection full of its leases' follows, and a second connection whose provider throws on opening
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    onTestFinished(bindLogSink({ emit: () => undefined }));
    const { createTransport: createBase, built } = createTransports({ followLimit: RPC_FOLLOW_LIMIT });
    let builds = 0;
    function createTransport(genesisHash: string, hooks: ChainTransportHooks): ChainTransport | null {
      const base = createBase(genesisHash, hooks);
      builds += 1;
      if (base === null || builds === 1) {
        return base;
      }
      return {
        ...base,
        provider: () => {
          throw new Error('open failed');
        },
      };
    }
    const pool = createChainPool({ createTransport, destroyDelay: Infinity });
    const halts: unknown[] = [];
    for (let index = 0; index < RPC_FOLLOW_LIMIT; index += 1) {
      const connection = remoteLease(pool, '0xaa', {
        onHalt: error => {
          halts.push(error);
        },
      });
      connection.send({ jsonrpc: '2.0', id: index, method: CHAIN_HEAD_FOLLOW, params: [true] });
    }

    // When the network panel watches
    const unwatch = pool.watch(createRecorder().watcher);

    // Then the watch returns its unwatch, the failure is reported once, and no lease halted
    expect(unwatch).toBeTypeOf('function');
    expect(captured).toMatchObject([{ step: 'chain_pool_watch_follow' }]);
    expect(metrics.counted('chain_pool.lane_open')).toEqual([{ outcome: 'error', reason: 'Error' }]);
    expect(halts).toEqual([]);
    expect(built).toHaveLength(2);
  });
});

describe('createChainPool pausing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('As a dotli page, I pause and my chains close at once under the same lease', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport });
    const onHalt = vi.fn();
    remoteLease(pool, '0xaa', { onHalt });

    // When
    pool.pause();

    // Then
    expect(must(built[0], 'transport').disconnect).toHaveBeenCalledTimes(1);
    expect(pool.status('0xaa')).toBe('disconnected');
    expect(onHalt).not.toHaveBeenCalled();
  });

  it('As a dotli page on a transport that connects at once, I resume and read the chain as connected', () => {
    // Given
    function createTransport(_genesisHash: string, hooks: ChainTransportHooks): ChainTransport {
      const provider: JsonRpcProvider = () => {
        hooks.onStatus('connecting');
        hooks.onStatus('connected');
        return { send: () => undefined, disconnect: () => undefined };
      };
      return { provider, followLimit: Infinity };
    }
    const pool = createChainPool({ createTransport });
    lease(pool, '0xaa');
    pool.pause();

    // When
    pool.resume();

    // Then
    expect(pool.status('0xaa')).toBe('connected');
  });

  it('As a dotli page, pausing or resuming twice closes and opens my chain once', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport });
    lease(pool, '0xaa');
    const transport = must(built[0], 'transport');

    // When
    pool.pause();
    pool.pause();

    // Then
    expect(transport.disconnect).toHaveBeenCalledTimes(1);

    // When
    pool.resume();
    pool.resume();

    // Then
    expect(transport.opened).toBe(2);
  });

  it('As a dotli page watching a transaction, I pause and hear it dropped', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport });
    const received: JsonRpcMessage[] = [];
    const connection = lease(pool, '0xaa', {
      onMessage: message => {
        received.push(message);
      },
    });
    connection.send({ jsonrpc: '2.0', id: 1, method: 'transactionWatch_v1_submitAndWatch', params: ['0xdead'] });
    const transport = must(built[0], 'transport');
    const upstream = must(transport.sent[0], 'upstream submit');
    transport.emit({ jsonrpc: '2.0', id: must(upstream.id, 'upstream id'), result: 'watch-1' });
    const ack = must(received[0], 'submit response') as { id: unknown; result: unknown };
    received.length = 0;

    // When
    pool.pause();

    // Then
    expect(received).toEqual([
      {
        jsonrpc: '2.0',
        method: 'transactionWatch_v1_watchEvent',
        params: { subscription: ack.result, result: { event: 'dropped' } },
      },
    ]);
  });

  it('As a dotli page, a chain I released before the resume stays closed until it is leased again', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: 1_000 });
    lease(pool, '0xaa').disconnect();
    const transport = must(built[0], 'transport');

    // When
    pool.pause();
    pool.resume();

    // Then
    expect(transport.opened).toBe(1);

    // When
    lease(pool, '0xaa');

    // Then
    expect(transport.opened).toBe(2);
  });

  it('As a dotli page, a chain that fails to close at a pause halts my lease on it while my other chain pauses', () => {
    // Given two leased chains, the first of which throws when its transport closes
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    onTestFinished(bindLogSink({ emit: () => undefined }));
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport });
    const failingHalt = vi.fn();
    const otherHalt = vi.fn();
    remoteLease(pool, '0xaa', { onHalt: failingHalt });
    remoteLease(pool, '0xbb', { onHalt: otherHalt });
    must(built[0], 'transport').disconnect.mockImplementation(() => {
      throw new Error('close failed');
    });

    // When
    const error = catchError(() => {
      pool.pause();
    });

    // Then
    expect(error).toBeUndefined();
    expect(must(built[1], 'transport').disconnect).toHaveBeenCalledTimes(1);
    expect(pool.status('0xbb')).toBe('disconnected');
    expect(otherHalt).not.toHaveBeenCalled();
    expect(failingHalt).toHaveBeenCalledTimes(1);
    expect(pool.status('0xaa')).toBe('disconnected');
    expect(captured).toMatchObject([{ step: 'chain_pool_pause' }]);
  });

  it('As a dotli page, a chain that fails to reopen at a resume halts my lease on it while my other chain opens', () => {
    // Given two leased chains, the first of which throws when its transport reopens
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    onTestFinished(bindLogSink({ emit: () => undefined }));
    const { createTransport, built } = createReopenFailingTransports('0xaa');
    const pool = createChainPool({ createTransport });
    const failingHalt = vi.fn();
    const otherHalt = vi.fn();
    remoteLease(pool, '0xaa', { onHalt: failingHalt });
    remoteLease(pool, '0xbb', { onHalt: otherHalt });
    pool.pause();

    // When
    const error = catchError(() => {
      pool.resume();
    });

    // Then
    expect(error).toBeUndefined();
    expect(must(built[1], 'transport').opened).toBe(2);
    expect(otherHalt).not.toHaveBeenCalled();
    expect(failingHalt).toHaveBeenCalledTimes(1);
    expect(pool.status('0xaa')).toBe('disconnected');
    expect(captured).toMatchObject([{ step: 'chain_pool_resume' }]);
  });

  it('As a dotli page, I lease a chain that fails to reopen after the resume and get a chain built in its place', () => {
    // Given a chain released before the pause, whose transport throws when it reopens
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    onTestFinished(bindLogSink({ emit: () => undefined }));
    const { createTransport, built } = createReopenFailingTransports('0xaa');
    const pool = createChainPool({ createTransport, destroyDelay: 1_000 });
    lease(pool, '0xaa').disconnect();
    pool.pause();
    pool.resume();
    const onHalt = vi.fn();

    // When
    const error = catchError(() => {
      remoteLease(pool, '0xaa', { onHalt });
    });

    // Then
    expect(error).toBeUndefined();
    expect(built).toHaveLength(2);
    expect(must(built[1], 'transport').opened).toBe(1);
    expect(pool.status('0xaa')).toBe('connecting');
    expect(onHalt).not.toHaveBeenCalled();
    expect(captured).toMatchObject([{ step: 'chain_pool_resume' }]);
  });
});

describe('createChainPool healing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('As a dotli integrator, two leases on a chain that halts take one rebuilt chain', () => {
    // Given two healing leases on one chain
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport });
    const first = lease(pool, '0xaa');
    const second = lease(pool, '0xaa');

    // When
    must(built[0], 'transport').hooks.onHalt(new Error('gone'));
    first.send({ jsonrpc: '2.0', id: 1, method: 'system_health', params: [] });
    second.send({ jsonrpc: '2.0', id: 2, method: 'system_health', params: [] });

    // Then
    expect(built).toHaveLength(2);
    expect(listMethod(must(built[1], 'transport'), 'system_health')).toHaveLength(2);
  });

  it('As a dotli integrator, my chain halts while the pool is paused and it is rebuilt closed', () => {
    // Given a healing lease on a paused pool
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport });
    lease(pool, '0xaa');
    pool.pause();

    // When
    must(built[0], 'transport').hooks.onHalt(new Error('gone'));

    // Then
    expect(built).toHaveLength(2);
    expect(must(built[1], 'transport').opened).toBe(0);

    // When
    pool.resume();

    // Then
    expect(must(built[1], 'transport').opened).toBe(1);
  });

  it('As a dotli integrator, I disconnect all and my healing lease is neither rebuilt nor sends', async () => {
    // Given a healing lease whose chain halted twice, so its next rebuild waits for the gate
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport });
    const onMessage = vi.fn();
    const connection = lease(pool, '0xaa', { onMessage });
    must(built[0], 'transport').hooks.onHalt(new Error('gone'));
    must(built[1], 'transport').hooks.onHalt(new Error('gone'));

    // When
    pool.disconnectAll();
    connection.send({ jsonrpc: '2.0', id: 1, method: 'system_health', params: [] });
    const pendingAfterDisconnect = vi.getTimerCount();
    await vi.runAllTimersAsync();

    // Then
    expect(pendingAfterDisconnect).toBe(0);
    expect(built).toHaveLength(2);
    expect(built.flatMap(record => listMethod(record, 'system_health'))).toHaveLength(0);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, I release a healing lease and disconnect all, and it is not released again', () => {
    // Given a healing lease released while its chain waits out its destroy delay
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: 1_000 });
    lease(pool, '0xaa').disconnect();

    // When
    pool.disconnectAll();

    // Then
    expect(must(built[0], 'transport').disconnect).toHaveBeenCalledTimes(1);
  });

  it("As a dotli integrator, my chain's transport halts while my lease opens on it and the lease takes the rebuilt chain", () => {
    // Given a transport that halts inside its first connect
    const { createTransport, built } = createHaltOnOpenTransports();
    const pool = createChainPool({ createTransport });

    // When
    lease(pool, '0xaa');

    // Then
    expect(built).toHaveLength(2);
    expect(must(built[1], 'transport').opened).toBe(1);
    expect(pool.status('0xaa')).toBe('connecting');
    expect(must(built[0], 'transport').disconnect).toHaveBeenCalledTimes(1);
  });

  it('As a dotli integrator, I connect remotely to a chain whose transport halts as it opens and my connect fails with the halt', () => {
    // Given a transport that halts inside its first connect
    const { createTransport, built } = createHaltOnOpenTransports();
    const pool = createChainPool({ createTransport });
    const onHalt = vi.fn<(error?: unknown) => void>();

    // When
    const error = catchError(() =>
      pool.connectRemote({ genesisHash: '0xaa', connectionId: 'halting', onMessage: () => undefined, onHalt }),
    );

    // Then
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty('cause', expect.objectContaining({ message: 'gone while opening' }));
    expect(onHalt).not.toHaveBeenCalled();
    expect(pool.status('0xaa')).toBe('disconnected');
    expect(built).toHaveLength(1);
    expect(must(built[0], 'transport').disconnect).toHaveBeenCalledTimes(1);
  });

  it('As the host page, my chain halts with the frame while the frame is down and it is rebuilt only as the frame gate allows', async () => {
    // Given a healing lease whose chain rides a frame that is down, already rebuilt once after a frame halt
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, isFrameDown: () => true });
    lease(pool, '0xaa');
    must(built[0], 'transport').hooks.onHalt(new ChainHaltError('frame'));

    // When the rebuilt chain halts with the frame too
    must(built[1], 'transport').hooks.onHalt(new ChainHaltError('frame'));
    await vi.advanceTimersByTimeAsync(999);

    // Then the second rebuild waits for the frame gate
    expect(built).toHaveLength(2);

    // When
    await vi.advanceTimersByTimeAsync(1);

    // Then
    expect(built).toHaveLength(3);
  });
});
