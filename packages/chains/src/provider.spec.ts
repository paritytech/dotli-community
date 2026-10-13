// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The light client over a fake truapi-provider engine, passed in as its start.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import type { JsonRpcConnection } from '@polkadot-api/json-rpc-provider';
import { DEBUG, getActiveServicesConfig, getActiveSupportedGenesisHashes } from '@dotli/config';
import { bindLogSink, type LogLevel } from '@dotli/shared';
import {
  createLightClient,
  lightClientDeps,
  type LightClient,
  type LightClientChange,
  type LightClientDeps,
  type LightClientEngine,
  type StartEngineOptions,
} from './provider.js';
import type { SmoldotDb } from './smoldot-db.js';
import type { ChainTransportHooks } from './transport-hooks.js';
import { bindRecordingSentry } from '@dotli/metrics/testing';

const waiting = new Set<() => void>();

/** Wakes each {@link until}, called by the fakes whenever what a test waits on may have changed. */
function changed(): void {
  for (const check of [...waiting]) {
    check();
  }
}

/** Resolves once `met` holds, checked now and at each {@link changed} rather than on a timer. */
function until(met: () => boolean): Promise<void> {
  return new Promise(resolve => {
    const check = (): void => {
      if (met()) {
        waiting.delete(check);
        resolve();
      }
    };
    waiting.add(check);
    check();
  });
}

/** A truapi-provider connection whose response stream the test drives. */
interface FakeConnection {
  send: (raw: string) => void;
  close: () => void;
  nextResponse: () => Promise<string | undefined>;
  /** The read the light client awaits now, so a test can wait until it was handled. */
  lastRead: Promise<string | undefined> | null;
  /** End the stream as a dead transport would, without `close()`. */
  end: () => void;
  /** Fail the next read, as a broken response stream would. */
  break: (error: Error) => void;
}

function createConnection(): FakeConnection {
  const queued: (string | undefined | Error)[] = [];
  let wake: ((value: string | undefined | Error) => void) | null = null;
  const push = (value: string | undefined | Error): void => {
    if (wake !== null) {
      const deliver = wake;
      wake = null;
      deliver(value);
      return;
    }
    queued.push(value);
  };
  const connection: FakeConnection = {
    send: () => undefined,
    close: () => {
      push(undefined);
    },
    lastRead: null,
    nextResponse: () => {
      const read = new Promise<string | undefined>((resolve, reject) => {
        const deliver = (value: string | undefined | Error): void => {
          if (value instanceof Error) {
            reject(value);
            return;
          }
          resolve(value);
        };
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
interface FakeEngine {
  start: Mock<(options: StartEngineOptions) => Promise<LightClientEngine>>;
  connections: FakeConnection[];
  connect: (genesisHash: string) => Promise<FakeConnection>;
  options: StartEngineOptions | null;
}

function fakeEngine(): FakeEngine {
  const fake: FakeEngine = {
    connections: [],
    connect: () => {
      const connection = createConnection();
      fake.connections.push(connection);
      return Promise.resolve(connection);
    },
    options: null,
    start: vi.fn<(options: StartEngineOptions) => Promise<LightClientEngine>>(options => {
      fake.options = options;
      changed();
      return Promise.resolve({
        loadDatabase: () => Promise.resolve(false),
        connect: genesisHash => fake.connect(genesisHash),
        lifecycle: () => ({ next: () => Promise.resolve(undefined), close: () => undefined }),
      });
    }),
  };
  return fake;
}

interface LogLine {
  level: LogLevel;
  message: string;
  args: unknown[] | undefined;
}

function recordLogs(): LogLine[] {
  const lines: LogLine[] = [];
  bindLogSink({
    emit: (level, message, _attrs, args) => {
      lines.push({ level, message, args });
      changed();
    },
  });
  return lines;
}

interface MockHooks {
  onStatus: Mock<ChainTransportHooks['onStatus']>;
  onHalt: Mock<ChainTransportHooks['onHalt']>;
  /** Resolves once `status` is the last status reported. */
  reported: (status: Parameters<ChainTransportHooks['onStatus']>[0]) => Promise<void>;
  /** Resolves once the chain halted `count` times. */
  halted: (count?: number) => Promise<void>;
}

function hooks(): MockHooks {
  const onStatus = vi.fn<ChainTransportHooks['onStatus']>(changed);
  const onHalt = vi.fn<ChainTransportHooks['onHalt']>(changed);
  return {
    onStatus,
    onHalt,
    reported: status => until(() => onStatus.mock.lastCall?.[0] === status),
    halted: (count = 1) => until(() => onHalt.mock.calls.length >= count),
  };
}

function deps(engine: FakeEngine, extra: Partial<LightClientDeps> = {}): LightClientDeps {
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
    engine = fakeEngine();
    logs = recordLogs();
    client = createLightClient(deps(engine));
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
    const chainHooks = hooks();

    // When
    open(chainHooks);

    // Then
    expect(chainHooks.onStatus).toHaveBeenCalledWith('connecting');
    await chainHooks.reported('connected');
    expect(chainHooks.onHalt).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, I open two chains at once and they share one light client start', async () => {
    // Given
    const first = hooks();
    const second = hooks();

    // When
    open(first);
    open(second, services.assethub.genesis);

    // Then
    await second.reported('connected');
    expect(first.onStatus).toHaveBeenLastCalledWith('connected');
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(logs.filter(line => line.message === 'Light client ready')).toHaveLength(1);
  });

  it('As a dotli integrator, I see a light-client stream that ends on its own halt the transport', async () => {
    // Given
    const chainHooks = hooks();
    open(chainHooks);
    await chainHooks.reported('connected');

    // When
    engine.connections[0]?.end();

    // Then
    await chainHooks.halted();
    expect(chainHooks.onHalt).toHaveBeenCalledTimes(1);
    expect(chainHooks.onStatus).toHaveBeenLastCalledWith('disconnected');
  });

  it('As a dotli integrator, I see a halt listener that throws on the end of the stream called once', async () => {
    // Given
    const chainHooks = hooks();
    chainHooks.onHalt.mockImplementation(() => {
      throw new Error('listener failed');
    });
    open(chainHooks);
    await chainHooks.reported('connected');

    // When
    engine.connections[0]?.end();

    // Then
    await until(() => logs.some(line => line.message.startsWith(`[dot.li provider] halt listener for chain`)));
    expect(chainHooks.onHalt).toHaveBeenCalledTimes(1);
  });

  it('As a dotli integrator, I close a light-client connection and it does not halt', async () => {
    // Given
    const chainHooks = hooks();
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
    const chainHooks = hooks();

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
    const chainHooks = hooks();
    open(chainHooks);
    await chainHooks.reported('connected');

    // When
    engine.connections[0]?.end();

    // Then
    await chainHooks.halted();
    expect(chainHooks.onHalt).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([]);
    expect(client.status().fatal).toBeNull();
    expect(logs).toContainEqual({ level: 'info', message: 'Light client ready', args: undefined });
    expect(logs.some(line => line.level === 'error')).toBe(false);
  });

  it('As a dotli user on a light client, I see a chain whose responses break after it connected halt on its own without failing the app', async () => {
    // Given
    const chainHooks = hooks();
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
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        args: [`[dot.li provider] chain ${people} read failed, halting it: malformed response`, failure],
      }),
    );
  });

  it('As a dotli user on a light client, I see a light client that cannot open a chain fail the app once', async () => {
    // Given
    const changes: LightClientChange[] = [];
    client.subscribe(change => changes.push(change));
    engine.connect = () => Promise.reject(new Error('catalog has no such chain'));
    const first = hooks();
    const second = hooks();

    // When
    open(first);
    open(second, services.assethub.genesis);

    // Then
    await second.halted();
    expect(second.onHalt).toHaveBeenCalledTimes(1);
    const message = `chain ${people} connection failed: catalog has no such chain`;
    expect(changes).toEqual([{ kind: 'fatal', message }]);
    expect(client.status().fatal).toBe(message);
    expect(logs).toContainEqual(expect.objectContaining({ level: 'error', args: [`[dot.li provider] ${message}`] }));
  });

  it('As a dotli user on a light client, I open a chain after a failed start and the light client starts again', async () => {
    // Given
    engine.start.mockRejectedValueOnce(new Error('wasm fetch failed'));
    const failed = hooks();
    open(failed);
    await failed.halted();
    expect(failed.onHalt).toHaveBeenCalledTimes(1);

    // When
    const retried = hooks();
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
    const first = hooks();
    const second = hooks();

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

  describe('stored databases', () => {
    function storeWith(load: SmoldotDb['load']): SmoldotDb {
      return { load, save: () => Promise.resolve() };
    }

    it('As the protocol frame, I hear the first database read of each chain and can read them all back later', async () => {
      // Given a light client whose store holds the relay
      client = createLightClient(deps(engine, { db: storeWith(() => Promise.resolve(BLOB)) }));
      const changes: LightClientChange[] = [];
      client.subscribe(change => changes.push(change));
      open(hooks());
      await until(() => engine.options !== null);

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
      client = createLightClient(deps(engine, { db: storeWith(() => Promise.reject(outage)) }));
      open(hooks());
      await until(() => engine.options !== null);

      // When
      const read = engine.options?.store?.load(services.bulletin.genesis);

      // Then
      await expect(read).rejects.toBe(outage);
      expect([...client.status().db]).toEqual([['bulletin', 'unavailable']]);
    });

    it('As the protocol frame on a browser without IndexedDB, I start the engine with no store', async () => {
      // When
      open(hooks());

      // Then
      await until(() => engine.options !== null);
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
      client = createLightClient(deps(engine, { gauge, heartbeatMs: 60_000 }));

      // When
      open(hooks());
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
      client = createLightClient(deps(engine, { gauge, heartbeatMs: 60_000 }));
      open(hooks());
      await vi.advanceTimersByTimeAsync(0);
      const beforeFatal = gauge.mock.calls.length;

      // When a chain cannot connect, which turns the light client fatal
      engine.connect = () => Promise.reject(new Error('catalog has no such chain'));
      open(hooks(), services.assethub.genesis);
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
      client = createLightClient(deps(engine, { gauge: null }));

      // When
      open(hooks());
      await vi.advanceTimersByTimeAsync(0);

      // Then
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('lightClientDeps', () => {
  function session(entries: Record<string, string>): Pick<Storage, 'getItem'> {
    return { getItem: key => entries[key] ?? null };
  }

  it('As a developer on localhost, I see the light client log at info', () => {
    // When
    const { logLevel } = lightClientDeps(null, 'host.localhost');

    // Then
    expect(logLevel).toBe('info');
  });

  it('As a visitor in production, I see the light client log nothing', () => {
    // When
    const { logLevel } = lightClientDeps(null, 'dot.li');

    // Then
    expect(logLevel).toBe('off');
  });

  it('As a tester, I set a log level in my session and it wins over the default', () => {
    // When
    const { logLevel } = lightClientDeps(session({ 'dotli:truapi-provider-log': 'debug' }), 'dot.li');

    // Then
    expect(logLevel).toBe('debug');
  });

  it('As a tester, I set a heartbeat interval in my session and it slows the heartbeat, and a bad one is ignored', () => {
    // When
    const slowed = lightClientDeps(session({ 'dotli:smoldot-heartbeat-ms': '3600000' }), 'dot.li');
    const bad = lightClientDeps(session({ 'dotli:smoldot-heartbeat-ms': 'soon' }), 'dot.li');

    // Then
    expect(slowed.heartbeatMs).toBe(3_600_000);
    expect(bad.heartbeatMs).toBeUndefined();
  });

  it('As a dotli operator on a build with metrics, my gauge reports the running light client', () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { gauge } = lightClientDeps(null, 'dot.li');

    // When
    gauge?.(1);

    // Then
    expect(metrics.gauges).toEqual([{ name: 'dotli.smoldot.active', value: 1, unit: 'none', attributes: undefined }]);
  });

  it("As a developer on a debug build, I get the debug console's log level hook", () => {
    // When
    const { debug } = lightClientDeps(null, 'dot.li');

    // Then
    expect(DEBUG).toBe(true);
    expect(debug).toBe(true);
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

  it('As a product, every chain the host runtime can expose is accepted', () => {
    // When
    const unsupported = [...getActiveSupportedGenesisHashes()].filter(hash => !lightClient.isChainSupported(hash));

    // Then
    expect(unsupported).toEqual([]);
  });

  it('As a product, a genesis hash of another network is refused', () => {
    // When
    const supported = lightClient.isChainSupported('0xdeadbeef');

    // Then
    expect(supported).toBe(false);
  });
});
