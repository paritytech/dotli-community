// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The light client over a fake truapi-provider engine, passed in as its start.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import type { JsonRpcConnection } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig, getActiveSupportedGenesisHashes } from '@dotli/config';
import { bindLogSink, type LogLevel } from '@dotli/shared';
import {
  createLightClient,
  createLightClientDeps,
  type LightClient,
  type LightClientChange,
  type LightClientDeps,
  type LightClientEngine,
  type StartEngineParams,
} from './createLightClient.js';
import type { SmoldotDb } from './createSmoldotDb.js';
import type { ChainTransportHooks } from './transportHooks.js';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';

const waiting = new Set<() => void>();

/** Wakes each {@link waitUntil}, called by the fakes whenever what a test waits on may have changed. */
function notifyChanged(): void {
  for (const check of [...waiting]) {
    check();
  }
}

/** Resolves once `met` holds, checked now and at each {@link notifyChanged} rather than on a timer. */
function waitUntil(met: () => boolean): Promise<void> {
  return new Promise(resolve => {
    function check(): void {
      if (met()) {
        waiting.delete(check);
        resolve();
      }
    }
    waiting.add(check);
    check();
  });
}

/** A truapi-provider connection whose response stream the test drives. */
type FakeConnection = {
  send: (raw: string) => void;
  close: () => void;
  nextResponse: () => Promise<string | undefined>;
  /** The read the light client awaits now, so a test can wait until it was handled. */
  lastRead: Promise<string | undefined> | null;
  /** End the stream as a dead transport would, without `close()`. */
  end: () => void;
  /** Fail the next read, as a broken response stream would. */
  break: (error: Error) => void;
};

function createConnection(): FakeConnection {
  const queued: (string | undefined | Error)[] = [];
  let wake: ((value: string | undefined | Error) => void) | null = null;
  function push(value: string | undefined | Error): void {
    if (wake !== null) {
      const deliver = wake;
      wake = null;
      deliver(value);
      return;
    }
    queued.push(value);
  }
  const connection: FakeConnection = {
    send: () => undefined,
    close: () => {
      push(undefined);
    },
    lastRead: null,
    nextResponse: () => {
      const read = new Promise<string | undefined>((resolve, reject) => {
        function deliver(value: string | undefined | Error): void {
          if (value instanceof Error) {
            reject(value);
            return;
          }
          resolve(value);
        }
        if (queued.length > 0) {
          deliver(queued.shift());
          return;
        }
        wake = deliver;
      });
      connection.lastRead = read.catch(() => undefined);
      return read;
    },
    end: () => {
      push(undefined);
    },
    break: (error: Error) => {
      push(error);
    },
  };
  return connection;
}

/** A started engine whose chains connect as `connect` says, with the store the light client handed it. */
type FakeEngine = {
  start: Mock<(options: StartEngineParams) => Promise<LightClientEngine>>;
  connections: FakeConnection[];
  connect: (genesisHash: string) => Promise<FakeConnection>;
  options: StartEngineParams | null;
};

function createFakeEngine(): FakeEngine {
  const fake: FakeEngine = {
    connections: [],
    connect: () => {
      const connection = createConnection();
      fake.connections.push(connection);
      return Promise.resolve(connection);
    },
    options: null,
    start: vi.fn<(options: StartEngineParams) => Promise<LightClientEngine>>(options => {
      fake.options = options;
      notifyChanged();
      return Promise.resolve({
        loadDatabase: () => Promise.resolve(false),
        connect: genesisHash => fake.connect(genesisHash),
        lifecycle: () => ({ next: () => Promise.resolve(undefined), close: () => undefined }),
      });
    }),
  };
  return fake;
}

type LogLine = {
  level: LogLevel;
  message: string;
  args: unknown[] | undefined;
};

function recordLogs(): LogLine[] {
  const lines: LogLine[] = [];
  bindLogSink({
    emit: ({ level, message, args }) => {
      lines.push({ level, message, args });
      notifyChanged();
    },
  });
  return lines;
}

type MockHooks = {
  onStatus: Mock<ChainTransportHooks['onStatus']>;
  onHalt: Mock<ChainTransportHooks['onHalt']>;
  /** Resolves once `status` is the last status reported. */
  reported: (status: Parameters<ChainTransportHooks['onStatus']>[0]) => Promise<void>;
  /** Resolves once the chain halted `count` times. */
  halted: (count?: number) => Promise<void>;
};

function createMockHooks(): MockHooks {
  const onStatus = vi.fn<ChainTransportHooks['onStatus']>(notifyChanged);
  const onHalt = vi.fn<ChainTransportHooks['onHalt']>(notifyChanged);
  return {
    onStatus,
    onHalt,
    reported: status => waitUntil(() => onStatus.mock.lastCall?.[0] === status),
    halted: (count = 1) => waitUntil(() => onHalt.mock.calls.length >= count),
  };
}

function createDeps(engine: FakeEngine, extra: Partial<LightClientDeps> = {}): LightClientDeps {
  return { db: null, logLevel: 'off', gauge: null, start: engine.start, ...extra };
}

const BLOB = 'x'.repeat(200_000);

let services: ReturnType<typeof getActiveServicesConfig>;
let people: string;
let relay: string;

beforeEach(() => {
  services = getActiveServicesConfig();
  people = services.people.genesis;
  relay = services.relay.genesis;
});

describe('createLightClient', () => {
  let engine: FakeEngine;
  let logs: LogLine[];
  let client: LightClient;

  beforeEach(() => {
    engine = createFakeEngine();
    logs = recordLogs();
    client = createLightClient(createDeps(engine));
  });

  function open(chainHooks: MockHooks, genesisHash = people): JsonRpcConnection {
    const provider = client.createChainProvider(genesisHash, chainHooks);
    if (provider === null) {
      throw new Error(`no provider for ${genesisHash}`);
    }
    return provider(() => undefined);
  }

  it('As a dotli integrator, I open a light-client connection and see it report connecting, then connected', async () => {
    // Given
    const chainHooks = createMockHooks();

    // When
    open(chainHooks);

    // Then
    expect(chainHooks.onStatus).toHaveBeenCalledWith('connecting');
    await chainHooks.reported('connected');
    expect(chainHooks.onHalt).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, I open two chains at once and they share one light client start', async () => {
    // Given
    const first = createMockHooks();
    const second = createMockHooks();

    // When
    open(first);
    open(second, services.assethub.genesis);

    // Then
    await second.reported('connected');
    expect(first.onStatus).toHaveBeenLastCalledWith('connected');
    expect(engine.start).toHaveBeenCalledTimes(1);
  });

  it('As a dotli integrator, I see a light-client stream that ends on its own halt the transport', async () => {
    // Given
    const chainHooks = createMockHooks();
    open(chainHooks);
    await chainHooks.reported('connected');

    // When
    engine.connections[0]?.end();

    // Then
    await chainHooks.halted();
    expect(chainHooks.onHalt).toHaveBeenCalledTimes(1);
    expect(chainHooks.onStatus).toHaveBeenLastCalledWith('disconnected');
  });

  it('As a dotli integrator, I see a halt listener that throws on the end of the stream called once and reported', async () => {
    // Given
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const chainHooks = createMockHooks();
    chainHooks.onHalt.mockImplementation(() => {
      throw new Error('listener failed');
    });
    open(chainHooks);
    await chainHooks.reported('connected');

    // When
    engine.connections[0]?.end();

    // Then
    await waitUntil(() => captured.length > 0);
    expect(chainHooks.onHalt).toHaveBeenCalledTimes(1);
    expect(captured).toEqual([{ flow: 'protocol', step: 'listener', tags: { owner: 'light_client.halt' } }]);
    expect(metrics.counted('listener.delivery')).toEqual([
      { outcome: 'error', reason: 'Error', owner: 'light_client.halt' },
    ]);
  });

  it('As a dotli integrator, I close a light-client connection and it does not halt', async () => {
    // Given
    const chainHooks = createMockHooks();
    const connection = open(chainHooks);
    await chainHooks.reported('connected');

    // When
    connection.disconnect();
    await engine.connections[0]?.lastRead;

    // Then
    expect(chainHooks.onHalt).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, I see a light-client connection that cannot connect halt with the cause', async () => {
    // Given
    const failure = new Error('catalog has no such chain');
    engine.connect = () => Promise.reject(failure);
    const chainHooks = createMockHooks();

    // When
    open(chainHooks);

    // Then
    await chainHooks.halted();
    expect(chainHooks.onHalt).toHaveBeenCalledWith(failure);
    expect(chainHooks.onStatus).toHaveBeenLastCalledWith('disconnected');
  });

  it('As a dotli user on a light client, I see one chain that stops responding halt on its own without failing the app', async () => {
    // Given
    const changes: LightClientChange[] = [];
    client.subscribe(change => changes.push(change));
    const chainHooks = createMockHooks();
    open(chainHooks);
    await chainHooks.reported('connected');

    // When
    engine.connections[0]?.end();

    // Then
    await chainHooks.halted();
    expect(chainHooks.onHalt).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([]);
    expect(client.status().fatal).toBeNull();
    expect(logs.some(line => line.level === 'error')).toBe(false);
  });

  it('As a dotli user on a light client, I see a chain whose responses break after it connected halt on its own without failing the app', async () => {
    // Given
    const chainHooks = createMockHooks();
    open(chainHooks);
    await chainHooks.reported('connected');
    const failure = new Error('malformed response');

    // When
    engine.connections[0]?.break(failure);

    // Then
    await chainHooks.halted();
    expect(chainHooks.onHalt).toHaveBeenCalledTimes(1);
    expect(chainHooks.onHalt).toHaveBeenCalledWith(failure);
    expect(chainHooks.onStatus).toHaveBeenLastCalledWith('disconnected');
    expect(client.status().fatal).toBeNull();
    expect(logs.some(line => line.level === 'error')).toBe(false);
  });

  it('As a dotli user on a light client, I see a light client that cannot open a chain fail the app once', async () => {
    // Given
    const changes: LightClientChange[] = [];
    client.subscribe(change => changes.push(change));
    engine.connect = () => Promise.reject(new Error('catalog has no such chain'));
    const first = createMockHooks();
    const second = createMockHooks();

    // When
    open(first);
    open(second, services.assethub.genesis);

    // Then
    await second.halted();
    expect(second.onHalt).toHaveBeenCalledTimes(1);
    const message = `chain ${people} connection failed: catalog has no such chain`;
    expect(changes).toEqual([{ kind: 'fatal', message }]);
    expect(client.status().fatal).toBe(message);
  });

  it('As a dotli user on a light client, I open a chain after a failed start and the light client starts again', async () => {
    // Given
    engine.start.mockRejectedValueOnce(new Error('wasm fetch failed'));
    const failed = createMockHooks();

    // When
    open(failed);

    // Then
    await failed.halted();
    expect(failed.onHalt).toHaveBeenCalledTimes(1);

    // When
    const retried = createMockHooks();
    open(retried);

    // Then
    await retried.reported('connected');
    expect(engine.start).toHaveBeenCalledTimes(2);
  });

  it('As a dotli user on a light client, I see a failed start mark the light client fatal exactly once', async () => {
    // Given a start that fails, with two chains queued behind it
    const changes: LightClientChange[] = [];
    client.subscribe(change => changes.push(change));
    engine.start.mockRejectedValue(new Error('wasm fetch failed'));
    const first = createMockHooks();
    const second = createMockHooks();

    // When
    open(first);
    open(second, services.assethub.genesis);

    // Then
    await second.halted();
    expect(second.onHalt).toHaveBeenCalledTimes(1);
    expect(first.onHalt).toHaveBeenCalledTimes(1);
    const message = `chain ${people} connection failed: wasm fetch failed`;
    expect(changes).toEqual([{ kind: 'fatal', message }]);
    expect(client.status().fatal).toBe(message);
  });

  it('As a dotli integrator, I see a light client listener that throws on the fatal change reported while the next one still hears it', async () => {
    // Given a start that fails, a listener that throws and one after it
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    client.subscribe(() => {
      throw new TypeError('listener broke');
    });
    const changes: LightClientChange[] = [];
    client.subscribe(change => changes.push(change));
    engine.start.mockRejectedValue(new Error('wasm fetch failed'));
    const first = createMockHooks();

    // When
    open(first);

    // Then
    await first.halted();
    expect(changes).toEqual([{ kind: 'fatal', message: `chain ${people} connection failed: wasm fetch failed` }]);
    expect(captured).toEqual([{ flow: 'protocol', step: 'listener', tags: { owner: 'light_client' } }]);
    expect(metrics.counted('listener.delivery')).toEqual([
      { outcome: 'error', reason: 'TypeError', owner: 'light_client' },
    ]);
  });

  describe('stored databases', () => {
    function createStore(load: SmoldotDb['load']): SmoldotDb {
      return { load, save: () => Promise.resolve() };
    }

    it('As the protocol frame, I hear the first database read of each chain and can read them all back later', async () => {
      // Given a light client whose store holds the relay
      client = createLightClient(createDeps(engine, { db: createStore(() => Promise.resolve(BLOB)) }));
      const changes: LightClientChange[] = [];
      client.subscribe(change => changes.push(change));
      open(createMockHooks());
      await waitUntil(() => engine.options !== null);

      // When the engine reads the relay twice, as a second add would
      await engine.options?.store?.load(relay);
      await engine.options?.store?.load(relay);

      // Then the first read counts, and a late reader finds it in the status
      expect(changes).toEqual([{ kind: 'db', chain: 'relay', outcome: 'hit' }]);
      expect([...client.status().db]).toEqual([['relay', 'hit']]);
    });

    it('As the protocol frame, I read a store that cannot answer as unavailable, and the engine hears the failure', async () => {
      // Given
      const outage = new Error('IndexedDB blocked');
      client = createLightClient(createDeps(engine, { db: createStore(() => Promise.reject(outage)) }));
      open(createMockHooks());
      await waitUntil(() => engine.options !== null);

      // When
      const read = engine.options?.store?.load(services.bulletin.genesis);

      // Then
      await expect(read).rejects.toBe(outage);
      expect([...client.status().db]).toEqual([['bulletin', 'unavailable']]);
    });

    it('As the protocol frame on a browser without IndexedDB, I start the engine with no store', async () => {
      // When
      open(createMockHooks());

      // Then
      await waitUntil(() => engine.options !== null);
      expect(engine.options?.store).toBeNull();
    });
  });

  describe('heartbeat', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('As a dotli operator, I count a light client the moment it starts and on every interval after', async () => {
      // Given
      const gauge = vi.fn<(value: number) => void>();
      client = createLightClient(createDeps(engine, { gauge, heartbeatMs: 60_000 }));

      // When
      open(createMockHooks());
      await vi.advanceTimersByTimeAsync(0);
      const atStart = gauge.mock.calls.length;
      await vi.advanceTimersByTimeAsync(180_000);

      // Then
      expect(atStart).toBe(1);
      expect(gauge.mock.calls).toEqual([[1], [1], [1], [1]]);
    });

    it('As a dotli operator, I count no beat after the light client turns fatal', async () => {
      // Given a counted light client
      const gauge = vi.fn<(value: number) => void>();
      client = createLightClient(createDeps(engine, { gauge, heartbeatMs: 60_000 }));
      open(createMockHooks());
      await vi.advanceTimersByTimeAsync(0);
      const beforeFatal = gauge.mock.calls.length;

      // When a chain cannot connect, which turns the light client fatal
      engine.connect = () => Promise.reject(new Error('catalog has no such chain'));
      open(createMockHooks(), services.assethub.genesis);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(180_000);

      // Then
      expect(client.status().fatal).not.toBeNull();
      expect(beforeFatal).toBe(1);
      expect(gauge).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('As a dotli operator on a build without metrics, I leave no timer running', async () => {
      // Given
      client = createLightClient(createDeps(engine, { gauge: null }));

      // When
      open(createMockHooks());
      await vi.advanceTimersByTimeAsync(0);

      // Then
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('createLightClientDeps', () => {
  function createSession(entries: Record<string, string>): Pick<Storage, 'getItem'> {
    return { getItem: key => entries[key] ?? null };
  }

  it.each<{
    role: string;
    session: Parameters<typeof createLightClientDeps>[0];
    local: boolean;
    level: LightClientDeps['logLevel'];
  }>([
    { role: 'a developer on localhost', session: null, local: true, level: 'info' },
    { role: 'a visitor in production', session: null, local: false, level: 'off' },
    {
      role: 'a tester who sets debug in my session',
      session: createSession({ 'dotli:truapi-provider-log': 'debug' }),
      local: false,
      level: 'debug',
    },
  ])('As $role, I see the light client log at level $level', ({ session, local, level }) => {
    // When
    const { logLevel } = createLightClientDeps(session, local);

    // Then
    expect(logLevel).toBe(level);
  });

  it('As a tester, I set a heartbeat interval in my session and it slows the heartbeat, and a bad one is ignored', () => {
    // When
    const slowed = createLightClientDeps(createSession({ 'dotli:smoldot-heartbeat-ms': '3600000' }), false);
    const bad = createLightClientDeps(createSession({ 'dotli:smoldot-heartbeat-ms': 'soon' }), false);

    // Then
    expect(slowed.heartbeatMs).toBe(3_600_000);
    expect(bad.heartbeatMs).toBeUndefined();
  });

  it('As a dotli operator on a build with metrics, I see my gauge report the running light client', () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { gauge } = createLightClientDeps(null, false);

    // When
    gauge?.(1);

    // Then
    expect(metrics.gauges).toEqual([{ name: 'dotli.smoldot.active', value: 1, unit: 'none', attributes: undefined }]);
  });
});

describe('isChainSupported', () => {
  // Support is decided before anything starts, so this light client never needs an engine.
  const lightClient = createLightClient({
    db: null,
    logLevel: 'off',
    gauge: null,
    start: () => Promise.reject(new Error('no engine in this test')),
  });

  it('As a product, I find every chain the host runtime can expose supported', () => {
    // When
    const unsupported = [...getActiveSupportedGenesisHashes()].filter(hash => !lightClient.isChainSupported(hash));

    // Then
    expect(unsupported).toEqual([]);
  });

  it('As a product, I find a genesis hash of another network unsupported', () => {
    // When
    const supported = lightClient.isChainSupported('0xdeadbeef');

    // Then
    expect(supported).toBe(false);
  });
});
