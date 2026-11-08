// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The light client over a fake truapi-provider engine, passed in as its start.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import type { JsonRpcConnection } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig, getActiveSupportedGenesisHashes } from '@dotli/config';
import { bindLogSink, createDeferred, type LogLevel } from '@dotli/shared';
import {
  createLightClient,
  createLightClientDeps,
  LightClientCapError,
  withConnectionCapError,
  type LightClient,
  type LightClientChange,
  type LightClientDeps,
  type LightClientEngine,
  type StartEngineParams,
} from './createLightClient.js';
import type { ChainSyncReporter } from './createChainSyncReporter.js';
import type { SmoldotDb } from './createSmoldotDb.js';
import { LIGHT_CLIENT_FOLLOW_LIMIT, type ChainTransportHooks } from './transportHooks.js';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';

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
  /** Every frame the light client sent on this connection. */
  sent: string[];
  close: () => void;
  nextResponse: () => Promise<string | undefined>;
  /** The read the light client awaits now, so a test can wait until it was handled. */
  lastRead: Promise<string | undefined> | null;
  /** End the stream as a dead transport would, without `close()`. */
  end: () => void;
  /** Fail the next read, as a broken response stream would. */
  break: (error: Error) => void;
  /** Deliver one response frame, as the node's answer would. */
  respond: (raw: string) => void;
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
    send: raw => {
      connection.sent.push(raw);
    },
    sent: [],
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
    respond: raw => {
      push(raw);
    },
  };
  return connection;
}

/** A started engine whose chains connect as `connect` says, with the store the light client handed it. */
type FakeEngine = {
  start: Mock<(options: StartEngineParams) => Promise<LightClientEngine>>;
  connections: FakeConnection[];
  connect: (genesisHash: string) => Promise<FakeConnection>;
  /** Reads the chain from the store the engine was handed, as the crate does for a chain it does not hold. */
  loadDatabase: (genesisHash: string) => Promise<boolean>;
  /** Holds the next start once it recorded its options, until the returned release runs. */
  holdStart: () => () => void;
  options: StartEngineParams | null;
};

function createFakeEngine(): FakeEngine {
  let held: Promise<undefined> | null = null;
  const started: LightClientEngine = {
    loadDatabase: genesisHash => fake.loadDatabase(genesisHash),
    connect: genesisHash => fake.connect(genesisHash),
    lifecycle: () => ({ next: () => Promise.resolve(undefined), close: () => undefined }),
  };
  const fake: FakeEngine = {
    connections: [],
    connect: () => {
      const connection = createConnection();
      fake.connections.push(connection);
      return Promise.resolve(connection);
    },
    loadDatabase: async genesisHash => {
      const store = fake.options?.store ?? null;
      if (store === null) {
        return false;
      }
      return (await store.load(genesisHash)) !== null;
    },
    holdStart: () => {
      const gate = createDeferred<undefined>();
      held = gate.promise;
      return () => {
        gate.resolve(undefined);
      };
    },
    options: null,
    start: vi.fn<(options: StartEngineParams) => Promise<LightClientEngine>>(options => {
      fake.options = options;
      notifyChanged();
      const gate = held;
      held = null;
      if (gate === null) {
        return Promise.resolve(started);
      }
      return gate.then(() => started);
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

/** A sync reporter's attach that counts its calls and hands back a tap that intercepts nothing. */
function createCountingAttach(): Mock<ChainSyncReporter['attachChainSync']> {
  return vi.fn<ChainSyncReporter['attachChainSync']>(() => ({ intercept: () => false, stop: () => undefined }));
}

/** A sync tap as the test sees it: the send it was handed and every frame its connection let it intercept. */
type RecordedTap = {
  send: (message: string) => void;
  intercepted: unknown[];
};

/** A sync reporter's attach that records each tap it attaches, whose intercept claims every frame. */
function createRecordingAttach(): { attachChainSync: ChainSyncReporter['attachChainSync']; taps: RecordedTap[] } {
  const taps: RecordedTap[] = [];
  return {
    taps,
    attachChainSync: ({ send }) => {
      const tap: RecordedTap = { send, intercepted: [] };
      taps.push(tap);
      return {
        intercept: parsed => {
          tap.intercepted.push(parsed);
          return true;
        },
        stop: () => undefined,
      };
    },
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
    const transport = client.createChainTransport(genesisHash, chainHooks);
    if (transport === null) {
      throw new Error(`no transport for ${genesisHash}`);
    }
    return transport.provider(() => undefined);
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

  it('As a dotli integrator, I open a light-client chain and its transport takes two follows per connection', () => {
    // Given a chain the network defines
    const chainHooks = createMockHooks();

    // When its transport opens
    const transport = client.createChainTransport(people, chainHooks);

    // Then the transport carries the light client's follow limit
    expect(transport?.followLimit).toBe(LIGHT_CLIENT_FOLLOW_LIMIT);
  });

  it('As a dotli integrator, I open two connections to one chain and only the first reports its sync', async () => {
    // Given a light client whose sync reporter counts the taps it attaches
    const attachChainSync = createCountingAttach();
    client = createLightClient(createDeps(engine, { attachChainSync }));
    const first = createMockHooks();
    const second = createMockHooks();

    // When two connections of one chain open and connect
    open(first);
    open(second);
    await Promise.all([first.reported('connected'), second.reported('connected')]);

    // Then only the first connection attached a sync tap
    expect(attachChainSync).toHaveBeenCalledTimes(1);
  });

  it("As a dotli integrator, I close the connection that reports a chain's sync and the chain's other open connection reports it, with no connection opened", async () => {
    // Given two connections of one chain, the first reporting its sync
    const { attachChainSync, taps } = createRecordingAttach();
    client = createLightClient(createDeps(engine, { attachChainSync }));
    const first = createMockHooks();
    const second = createMockHooks();
    const reporting = open(first);
    open(second);
    await Promise.all([first.reported('connected'), second.reported('connected')]);
    const remaining = engine.connections[1];

    // When the first closes, then the tap now attached sends and the second connection answers it
    reporting.disconnect();
    taps[1]?.send('peers request');
    const read = remaining?.lastRead;
    remaining?.respond('{"jsonrpc":"2.0","id":"peers","result":[]}');
    await read;

    // Then the second connection carries the new tap's request and its answer reaches that tap, with no third opened
    expect(taps).toHaveLength(2);
    expect(engine.connections).toHaveLength(2);
    expect(remaining?.sent).toEqual(['peers request']);
    expect(taps[1]?.intercepted).toEqual([{ jsonrpc: '2.0', id: 'peers', result: [] }]);
  });

  it("As a dotli integrator, I see the connection that reports a chain's sync end its stream and the chain's other open connection reports it, with no connection opened", async () => {
    // Given two connections of one chain, the first reporting its sync
    const { attachChainSync, taps } = createRecordingAttach();
    client = createLightClient(createDeps(engine, { attachChainSync }));
    const first = createMockHooks();
    const second = createMockHooks();
    open(first);
    open(second);
    await Promise.all([first.reported('connected'), second.reported('connected')]);

    // When the first connection's stream ends, then the tap now attached sends
    engine.connections[0]?.end();
    await first.halted();
    taps[1]?.send('peers request');

    // Then the new tap sends on the second connection, with no third opened
    expect(taps).toHaveLength(2);
    expect(engine.connections).toHaveLength(2);
    expect(engine.connections[1]?.sent).toEqual(['peers request']);
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
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
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
    expect(captured).toMatchObject([{ step: 'listener', tags: { owner: 'light_client.halt' } }]);
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

  it("As a dotli integrator, I open a connection past the light client's cap and only that chain halts", async () => {
    // Given an engine that refuses the people chain at its cap and opens any other chain
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const cap = new LightClientCapError(people, new Error('the light client already holds 32 connections'));
    const connect = engine.connect;
    engine.connect = genesisHash => (genesisHash === people ? Promise.reject(cap) : connect(genesisHash));
    const refused = createMockHooks();
    const other = createMockHooks();

    // When a connection of the people chain opens, and then one of another chain
    open(refused);
    await refused.halted();
    open(other, services.assethub.genesis);
    await other.reported('connected');

    // Then only the people chain halted, the cap is counted, and the other chain opened
    expect(refused.onHalt).toHaveBeenCalledWith(cap);
    expect(other.onHalt).not.toHaveBeenCalled();
    expect(client.status().fatal).toBeNull();
    expect(metrics.counted('smoldot.connection_cap')).toEqual([{ outcome: 'error', reason: 'cap' }]);
  });

  it('As a dotli user on a light client, I open a chain after the light client turned fatal and it halts without starting the engine again', async () => {
    // Given a failed start, which turns the light client fatal
    engine.start.mockRejectedValueOnce(new Error('wasm fetch failed'));
    const failed = createMockHooks();
    open(failed);
    await failed.halted();
    const later = createMockHooks();

    // When
    open(later, services.assethub.genesis);
    await later.halted();

    // Then
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(later.onHalt).toHaveBeenCalledTimes(1);
    expect(client.status().fatal).toBe(`chain ${people} connection failed: wasm fetch failed`);
  });

  it('As a dotli user on a light client, I see two chains queued behind a failed start halt and the engine start once', async () => {
    // Given a start that fails once, when the test rejects it
    const gate = createDeferred<LightClientEngine>();
    engine.start.mockReturnValueOnce(gate.promise);
    const first = createMockHooks();
    const second = createMockHooks();

    // When two chains open before the start fails
    open(first);
    open(second, services.assethub.genesis);
    gate.reject(new Error('wasm fetch failed'));
    await first.halted();
    await second.halted();

    // Then
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(first.onHalt).toHaveBeenCalledTimes(1);
    expect(second.onHalt).toHaveBeenCalledTimes(1);
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
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
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
    expect(captured).toMatchObject([{ step: 'listener', tags: { owner: 'light_client' } }]);
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

    it('As the protocol frame, I open a chain while the light client starts and its stored database is read before the start ends, once', async () => {
      // Given a start held open and a store that holds the relay
      const release = engine.holdStart();
      const load = vi.fn<SmoldotDb['load']>(() => Promise.resolve(BLOB));
      client = createLightClient(createDeps(engine, { db: createStore(load) }));
      const chainHooks = createMockHooks();

      // When the relay opens
      open(chainHooks, relay);

      // Then its database is read while the engine still starts
      expect(load).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledWith(relay);

      // When the start ends and the relay connects
      release();
      await chainHooks.reported('connected');

      // Then the engine took that read as a hit, with no second read
      expect(load).toHaveBeenCalledTimes(1);
      expect([...client.status().db]).toEqual([['relay', 'hit']]);
    });

    it('As the protocol frame, I open the relay and a parachain while the light client starts and the engine reading the relay for the parachain leaves one read and one change per chain', async () => {
      // Given a start held open, a store that holds both chains, and an engine that reads the relay first for a parachain
      // and a chain it already holds not again
      const release = engine.holdStart();
      const load = vi.fn<SmoldotDb['load']>(() => Promise.resolve(BLOB));
      client = createLightClient(createDeps(engine, { db: createStore(load) }));
      const changes: LightClientChange[] = [];
      client.subscribe(change => changes.push(change));
      const assethub = services.assethub.genesis;
      const held = new Set<string>();
      async function read(genesisHash: string): Promise<boolean> {
        const store = engine.options?.store ?? null;
        if (store === null || held.has(genesisHash)) {
          return held.has(genesisHash);
        }
        held.add(genesisHash);
        return (await store.load(genesisHash)) !== null;
      }
      engine.loadDatabase = async genesisHash => {
        if (genesisHash === assethub) {
          await read(relay);
        }
        return read(genesisHash);
      };
      const relayHooks = createMockHooks();
      const assethubHooks = createMockHooks();

      // When both open, the start ends and both connect
      open(relayHooks, relay);
      open(assethubHooks, assethub);
      release();
      await Promise.all([relayHooks.reported('connected'), assethubHooks.reported('connected')]);

      // Then each chain was read once and each has one change
      expect(load).toHaveBeenCalledTimes(2);
      expect(load).toHaveBeenCalledWith(relay);
      expect(load).toHaveBeenCalledWith(assethub);
      expect(changes).toEqual([
        { kind: 'db', chain: 'relay', outcome: 'hit' },
        { kind: 'db', chain: 'assethub', outcome: 'hit' },
      ]);
    });

    it('As the protocol frame, I open one chain twice while the light client starts and its stored database is read once before the start ends', () => {
      // Given a start held open and a store that holds the relay
      engine.holdStart();
      const load = vi.fn<SmoldotDb['load']>(() => Promise.resolve(BLOB));
      client = createLightClient(createDeps(engine, { db: createStore(load) }));

      // When
      open(createMockHooks(), relay);
      open(createMockHooks(), relay);

      // Then
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('As the protocol frame, I reopen a chain the engine already holds and its stored database is not read again', async () => {
      // Given the relay connected once, and an engine that now holds its database and reads nothing for it
      const load = vi.fn<SmoldotDb['load']>(() => Promise.resolve(BLOB));
      client = createLightClient(createDeps(engine, { db: createStore(load) }));
      const first = createMockHooks();
      open(first, relay);
      await first.reported('connected');
      engine.loadDatabase = () => Promise.resolve(true);
      const second = createMockHooks();

      // When
      open(second, relay);
      await second.reported('connected');

      // Then
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('As the protocol frame, I open a chain while the light client starts and a store that cannot answer leaves it cold and unavailable', async () => {
      // Given a start held open, a store that fails and the relay opened
      const release = engine.holdStart();
      const outage = new Error('IndexedDB blocked');
      const load = vi.fn<SmoldotDb['load']>(() => Promise.reject(outage));
      client = createLightClient(createDeps(engine, { db: createStore(load) }));
      const chainHooks = createMockHooks();
      open(chainHooks, relay);

      // When
      release();
      await chainHooks.reported('connected');

      // Then
      expect(chainHooks.onHalt).not.toHaveBeenCalled();
      expect([...client.status().db]).toEqual([['relay', 'unavailable']]);
      const warnings = logs.filter(
        line =>
          line.level === 'warn' && line.message.startsWith(`[dot.li provider] warm start unavailable for ${relay}`),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.args?.[1]).toBe(outage);
    });

    it('As the protocol frame, I open a chain after a failed start and its stored database is not read again', async () => {
      // Given a failed start of the relay, with a store that holds it
      engine.start.mockRejectedValueOnce(new Error('wasm fetch failed'));
      const load = vi.fn<SmoldotDb['load']>(() => Promise.resolve(BLOB));
      client = createLightClient(createDeps(engine, { db: createStore(load) }));
      const changes: LightClientChange[] = [];
      client.subscribe(change => changes.push(change));
      const failed = createMockHooks();
      open(failed, relay);
      await failed.halted();
      const reopened = createMockHooks();

      // When
      open(reopened, relay);
      await reopened.halted();

      // Then
      expect(load).toHaveBeenCalledTimes(1);
      expect(changes).toEqual([{ kind: 'fatal', message: `chain ${relay} connection failed: wasm fetch failed` }]);
    });

    it('As the protocol frame, I open a chain while the light client fails to start and a store that cannot answer leaves no unhandled failure', async () => {
      // Given a start that fails and a store that fails, read through a plain function since a mock marks the
      // rejections it returns handled
      engine.start.mockRejectedValueOnce(new Error('wasm fetch failed'));
      client = createLightClient(
        createDeps(engine, { db: createStore(() => Promise.reject(new Error('IndexedDB blocked'))) }),
      );
      const chainHooks = createMockHooks();

      // When
      open(chainHooks, relay);
      await chainHooks.halted();

      // Then the chain halts as before, and the guard is that Vitest fails the run on an unhandled rejection
      expect([...client.status().db]).toEqual([]);
      expect(client.status().fatal).toBe(`chain ${relay} connection failed: wasm fetch failed`);
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

describe('withConnectionCapError', () => {
  function createEngineRejecting(error: Error): LightClientEngine {
    return {
      loadDatabase: () => Promise.resolve(false),
      connect: () => Promise.reject(error),
      lifecycle: () => ({ next: () => Promise.resolve(undefined), close: () => undefined }),
    };
  }

  it("As a dotli integrator, I see the wasm's connection cap text become a typed cap error that keeps the original", async () => {
    // Given an engine whose connect rejects with the wasm's cap text
    const original = new Error('the light client already holds 32 connections');
    const engine = withConnectionCapError(createEngineRejecting(original));

    // When a chain connects
    const rejection = await engine.connect('0xaa').catch((error: unknown) => error);

    // Then the rejection is a cap error caused by the original
    expect(rejection).toBeInstanceOf(LightClientCapError);
    expect((rejection as LightClientCapError).cause).toBe(original);
  });

  it('As a dotli integrator, I see any other connect failure pass through unchanged', async () => {
    // Given an engine whose connect rejects for another reason
    const original = new Error('catalog has no such chain');
    const engine = withConnectionCapError(createEngineRejecting(original));

    // When a chain connects
    const rejection = await engine.connect('0xaa').catch((error: unknown) => error);

    // Then the same error comes back
    expect(rejection).toBe(original);
  });
});
