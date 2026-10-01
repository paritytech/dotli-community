// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  JsonRpcConnection,
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from '@polkadot-api/json-rpc-provider';
import type { ChainTransportHooks } from '@dotli/resolver';
import { getActiveServicesConfig } from '@dotli/config';
import { createCoreRpcChainProvider } from '../../resolver/src/rpc-chain.js';
import { FakeWebSocket } from '../../resolver/tests/fake-websocket.js';
import { createChainPool, type ChainPool } from '../src/chain-pool.js';

interface TransportRecord {
  genesisHash: string;
  hooks: ChainTransportHooks;
  sent: JsonRpcRequest[];
  emit: (message: JsonRpcMessage) => void;
  disconnect: Mock<() => void>;
  opened: number;
}

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

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`missing ${what}`);
  }
  return value;
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

  it('As a dotli integrator, leases on one chain share one transport, and each chain gets its own', () => {
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

  it('As a dotli integrator, a chain closes destroyDelay after its last lease, unless a new lease arrives first', async () => {
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

  it('As a dotli integrator, an infinite destroyDelay keeps a chain after its last lease', async () => {
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

  it('As a dotli integrator, a destroyDelay function sets the delay per chain', async () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({
      createTransport,
      destroyDelay: genesisHash => (genesisHash === '0xaa' ? Infinity : 1_000),
    });
    const kept = lease(pool, '0xaa');
    const closing = lease(pool, '0xbb');

    // When
    kept.disconnect();
    closing.disconnect();
    await vi.advanceTimersByTimeAsync(5_000);

    // Then
    expect(must(built[0], 'kept transport').disconnect).not.toHaveBeenCalled();
    expect(must(built[1], 'closing transport').disconnect).toHaveBeenCalledTimes(1);
  });

  it('As a dotli integrator, a throwing status listener neither stops the others nor reaches the transport', () => {
    // Given
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
  });

  it('As a dotli integrator, a provider nobody calls does not keep its chain', async () => {
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

  it('As a dotli integrator, a halted transport ends every lease once and the next lease rebuilds the chain', () => {
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

  it('As a dotli integrator, a lease released after its chain was rebuilt leaves the new connection alone', () => {
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

  it('As a dotli integrator, the pool reports each chain status and ignores a closed transport', () => {
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

  it('As a dotli integrator, a chain the factory cannot reach builds nothing', () => {
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

  it('As a dotli integrator, a remote connection is a lease, and a duplicate connection id leaks none', () => {
    // Given
    const { createTransport, built } = createTransports();
    const pool = createChainPool({ createTransport, destroyDelay: 0 });
    const remote = must(pool.connectRemote('0xaa', 'conn-1', () => undefined), 'remote connection');

    // When
    expect(() => pool.connectRemote('0xaa', 'conn-1', () => undefined)).toThrow('Duplicate broker session');
    remote.disconnect();

    // Then
    expect(must(built[0], 'transport').disconnect).toHaveBeenCalledTimes(1);
    expect(pool.status('0xaa')).toBe('disconnected');
  });

  it('As a dotli integrator, disconnectAll closes every chain without halting its leases', () => {
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

  it('As a dotli integrator, a transaction watch reaches its lease as dropped when the transport disconnects', () => {
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

  it('As a dotli integrator, a chain rebuilt by a halt handler reports its own status', () => {
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
});

/** A transport factory whose transports can be paused, recording what happens in order. */
function createPausableTransports(): {
  createTransport: (genesisHash: string, hooks: ChainTransportHooks) => JsonRpcProvider | null;
  events: string[];
} {
  const events: string[] = [];
  const createTransport = (genesisHash: string): JsonRpcProvider => {
    const transport: JsonRpcProvider = (): JsonRpcConnection => {
      events.push(`open ${genesisHash}`);
      return { send: () => undefined, disconnect: () => undefined };
    };
    return Object.assign(transport, {
      pause: () => {
        events.push(`pause ${genesisHash}`);
      },
      resume: () => {
        events.push(`resume ${genesisHash}`);
      },
    });
  };
  return { createTransport, events };
}

describe('createChainPool pausing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('As a dotli integrator, pausing reaches every pausable transport once and skips the others', () => {
    // Given
    const pausable = createPausableTransports();
    const plain = createTransports();
    const pool = createChainPool({
      createTransport: (genesisHash, hooks) =>
        genesisHash === '0xaa' ? pausable.createTransport(genesisHash, hooks) : plain.createTransport(genesisHash, hooks),
    });
    lease(pool, '0xaa');
    lease(pool, '0xbb');

    // When
    pool.pauseAll();
    pool.pauseAll();
    pool.resumeAll();
    pool.resumeAll();

    // Then
    expect(pausable.events).toEqual(['open 0xaa', 'pause 0xaa', 'resume 0xaa']);
  });

  it('As a dotli integrator, a chain first leased while paused is paused before it opens', () => {
    // Given
    const { createTransport, events } = createPausableTransports();
    const pool = createChainPool({ createTransport });
    pool.pauseAll();

    // When
    lease(pool, '0xaa');

    // Then
    expect(events).toEqual(['pause 0xaa', 'open 0xaa']);
    expect(pool.status('0xaa')).toBe('disconnected');

    // When
    pool.resumeAll();

    // Then
    expect(events).toEqual(['pause 0xaa', 'open 0xaa', 'resume 0xaa']);
  });

  it('As a dotli integrator, a chain that closes while paused is left alone by the resume', async () => {
    // Given
    const { createTransport, events } = createPausableTransports();
    const pool = createChainPool({ createTransport, destroyDelay: 1_000 });
    const connection = lease(pool, '0xaa');
    pool.pauseAll();
    connection.disconnect();
    await vi.advanceTimersByTimeAsync(1_000);

    // When
    pool.resumeAll();

    // Then
    expect(pool.status('0xaa')).toBe('disconnected');
    expect(events).toEqual(['open 0xaa', 'pause 0xaa']);
  });

  it('As a dotli user on Trusted Providers, a paused chain closes its socket, and resuming replays its subscription and the sends held meanwhile', async () => {
    // Given
    vi.stubGlobal('WebSocket', FakeWebSocket);
    FakeWebSocket.instances = [];
    const people = getActiveServicesConfig().people.genesis;
    const pool = createChainPool({ createTransport: (genesisHash, hooks) => createCoreRpcChainProvider(genesisHash, hooks) });
    const received: JsonRpcMessage[] = [];
    const connection = lease(pool, people, message => {
      received.push(message);
    });
    connection.send({ jsonrpc: '2.0', id: 1, method: 'statement_subscribeStatement', params: [{ matchAll: [] }] });
    await vi.advanceTimersByTimeAsync(0);
    const first = must(FakeWebSocket.instances[0], 'first socket');
    first.open();
    const subscribe = must(first.requests('statement_subscribeStatement')[0], 'subscribe');
    first.deliver({ jsonrpc: '2.0', id: subscribe.id, result: 'srv-1' });
    const localToken = (must(received[0], 'subscribe response') as { result: unknown }).result;

    // When
    pool.pauseAll();
    connection.send({ jsonrpc: '2.0', id: 2, method: 'chainSpec_v1_genesisHash', params: [] });
    await vi.advanceTimersByTimeAsync(30_000);

    // Then
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(pool.status(people)).toBe('disconnected');

    // When
    pool.resumeAll();
    await vi.advanceTimersByTimeAsync(0);
    const second = must(FakeWebSocket.instances[1], 'second socket');
    second.open();
    const resubscribe = must(second.requests('statement_subscribeStatement')[0], 'resubscribe');
    second.deliver({ jsonrpc: '2.0', id: resubscribe.id, result: 'srv-2' });
    second.deliver({
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: { subscription: 'srv-2', result: { event: 'newStatements', data: { statements: ['0x01'], remaining: 0 } } },
    });

    // Then
    expect(second.requests('statement_subscribeStatement')).toHaveLength(1);
    expect(second.requests('chainSpec_v1_genesisHash')).toHaveLength(1);
    expect(received.at(-1)).toEqual({
      jsonrpc: '2.0',
      method: 'statement_statement',
      params: { subscription: localToken, result: { event: 'newStatements', data: { statements: ['0x01'], remaining: 0 } } },
    });
  });
});
