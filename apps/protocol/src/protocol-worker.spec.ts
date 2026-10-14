// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The light client and the resolver functions the worker is given are fakes, and the worker global is a fake scope.

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { deferred, must } from '@dotli/shared/testing';
import type { JsonRpcConnection } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig, getNetwork } from '@dotli/config';
import { bindCaptureSink, type m } from '@dotli/metrics';
import type { ProtocolRequestEnvelope } from '@dotli/protocol';
import type { LightClient, LightClientChange, SmoldotDbChain, SmoldotDbOutcome } from '@dotli/chains';
import { bindLogSink, type LogLevel } from '@dotli/shared';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import {
  HEARTBEAT_MISSED_BEATS,
  startProtocolWorker,
  workerNetwork,
  type HeartbeatClock,
  type WorkerResolver,
  type WorkerScope,
} from './protocol-worker.js';

type ChainSyncEvent = Parameters<Parameters<WorkerResolver['onChainSync']>[0]>[0];
type ChainDetail = Parameters<Parameters<WorkerResolver['onChainDetail']>[0]>[0];
type DotnsResolverDeps = Parameters<WorkerResolver['createDotnsResolver']>[0];
type SpanOpen = typeof m.open;

const captures = { exception: vi.fn(), expected: vi.fn() };
bindCaptureSink(captures);

interface LogLine {
  level: LogLevel;
  message: string;
  attrs: Record<string, unknown> | undefined;
  args: unknown[] | undefined;
}

/** The light client and resolver the worker drives, with the levers a test pulls. */
interface FakeLightClient {
  lightClient: LightClient;
  resolver: WorkerResolver;
  /** The light client dies. */
  fatal: (message: string) => void;
  /** The light client reads a chain's stored database. */
  readDb: (chain: SmoldotDbChain, outcome: SmoldotDbOutcome) => void;
  /** Replayed to each new subscriber, as the resolver does. */
  sync: ChainSyncEvent[];
  detail: ChainDetail[];
  syncListeners: Set<(event: ChainSyncEvent) => void>;
  detailListeners: Set<(detail: ChainDetail) => void>;
  /** The disconnect of each chain connection the worker opened, in order. */
  disconnects: Mock<() => void>[];
  /** The genesis hash of each chain connection the worker opened, in order. */
  chains: string[];
  /** What the worker built its name resolver on. */
  dotnsDeps: DotnsResolverDeps | null;
  /** Each sync reporting call, with how many chains were already open when it came. */
  syncReporting: { chains: readonly string[]; openBefore: number }[];
  /** The pre-sync the worker awaited, or an already settled promise where the test holds it. */
  presyncDone: Promise<void>;
  /** How many times the worker started warming People. */
  peopleWarms: number;
}

function fakeLightClient(
  options: {
    presync?: () => Promise<void>;
    resolveDotName?: () => Promise<string | null>;
    sync?: ChainSyncEvent[];
    detail?: ChainDetail[];
  } = {},
): FakeLightClient {
  const listeners = new Set<(change: LightClientChange) => void>();
  const db = new Map<SmoldotDbChain, SmoldotDbOutcome>();
  let fatal: string | null = null;
  const defaultPresync = Promise.resolve();
  const tell = (change: LightClientChange): void => {
    for (const listener of listeners) {
      listener(change);
    }
  };
  const light: FakeLightClient = {
    fatal: message => {
      fatal = message;
      tell({ kind: 'fatal', message });
    },
    readDb: (chain, outcome) => {
      db.set(chain, outcome);
      tell({ kind: 'db', chain, outcome });
    },
    sync: options.sync ?? [],
    detail: options.detail ?? [],
    syncListeners: new Set(),
    detailListeners: new Set(),
    disconnects: [],
    chains: [],
    dotnsDeps: null,
    syncReporting: [],
    peopleWarms: 0,
    presyncDone: options.presync === undefined ? defaultPresync : Promise.resolve(),
    lightClient: {
      createChainProvider: genesisHash => {
        light.chains.push(genesisHash);
        const disconnect = vi.fn<() => void>();
        light.disconnects.push(disconnect);
        return (): JsonRpcConnection => ({ send: () => undefined, disconnect });
      },
      isChainSupported: () => true,
      status: () => ({ fatal, db: new Map(db) }),
      subscribe: listener => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    resolver: undefined as unknown as WorkerResolver,
  };
  light.resolver = {
    enableSyncReporting: chains => {
      light.syncReporting.push({ chains, openBefore: light.chains.length });
    },
    onChainSync: cb => {
      light.sync.forEach(cb);
      light.syncListeners.add(cb);
      return () => {
        light.syncListeners.delete(cb);
      };
    },
    onChainDetail: cb => {
      light.detail.forEach(cb);
      light.detailListeners.add(cb);
      return () => {
        light.detailListeners.delete(cb);
      };
    },
    createDotnsResolver: deps => {
      light.dotnsDeps = deps;
      return {
        status: { get: () => 'idle', subscribe: () => () => undefined },
        resolveDotName: options.resolveDotName ?? (() => Promise.resolve(null)),
        resolveExecutableManifest: () => Promise.reject(new Error('no manifests in this test')),
        resolveOwner: () => Promise.resolve(null),
        resolveRootManifest: () => Promise.reject(new Error('no manifests in this test')),
        waitForAssetHubFinalized: options.presync ?? (() => defaultPresync),
        // Never settles, as People warms in the background.
        waitForPeopleFinalized: () => {
          light.peopleWarms += 1;
          return new Promise<void>(() => undefined);
        },
      };
    },
  };
  return light;
}

interface FakePort {
  posted: Mock<(message: unknown) => void>;
  port: MessagePort;
  /** Deliver a message from the tab's iframe to the worker. */
  receive: (data: unknown) => void;
  /** Settles once the port has been handed `count` more messages, pings aside, whether or not the send threw. */
  postedMore: (count?: number) => Promise<void>;
}

function fakePort(): FakePort {
  const posted = vi.fn<(message: unknown) => void>();
  const listeners: ((event: MessageEvent) => void)[] = [];
  const waiters: { target: number; resolve: () => void }[] = [];
  let delivered = 0;
  const port = {
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
      listeners.push(listener);
    },
    start: () => undefined,
    postMessage: (message: unknown): void => {
      try {
        posted(message);
      } finally {
        if (!isPing(message)) {
          delivered += 1;
          for (const waiter of waiters.filter(w => w.target <= delivered)) {
            waiter.resolve();
          }
        }
      }
    },
  } as unknown as MessagePort;
  return {
    posted,
    port,
    receive: data => {
      for (const listener of listeners) {
        listener({ data } as MessageEvent);
      }
    },
    postedMore: (count = 1) =>
      new Promise<void>(resolve => {
        waiters.push({ target: delivered + count, resolve });
      }),
  };
}

/** Sends a tab's message and settles once the worker has answered it with `count` messages. */
async function ask(port: FakePort, data: unknown, count = 1): Promise<void> {
  const answered = port.postedMore(count);
  port.receive(data);
  await answered;
}

type Presync = ReturnType<typeof deferred<undefined>>;

/**
 * Ends a held pre-sync and settles once the worker has acted on it. The worker awaited that promise before the test
 * did, so its continuation, and every message it sends, has run by then.
 */
async function endPresync(presync: Presync, failure?: Error): Promise<void> {
  if (failure === undefined) {
    presync.resolve(undefined);
  } else {
    presync.reject(failure);
  }
  await presync.promise.then(
    () => undefined,
    () => undefined,
  );
}

interface Worker {
  /** A tab's iframe connects, on a port the test may have rigged first. */
  connect: (port?: FakePort) => FakePort;
  /** One heartbeat interval passes, if the worker has not stopped its heartbeat. */
  beat: () => void;
  close: Mock<() => void>;
  closed: Promise<void>;
  /** Settles one timer turn after the worker closes, so a second close scheduled alongside the first has run too. */
  closedOnce: Promise<void>;
  logs: LogLine[];
  open: Mock<SpanOpen>;
}

/**
 * Starts a worker on a fake scope, as the browser does when the first tab names it. Settles once the worker has acted
 * on a pre-sync that is already done, as it awaited that promise first.
 */
async function bootWorker(
  light: FakeLightClient,
  name = 'dotli-protocol-paseo-next-v2',
  flush: () => Promise<void> = () => Promise.resolve(),
): Promise<Worker> {
  let beat: () => void = () => undefined;
  const heartbeat: HeartbeatClock = {
    start: onBeat => {
      beat = onBeat;
      return () => {
        beat = () => undefined;
      };
    },
  };
  const logs: LogLine[] = [];
  bindLogSink({
    emit: (level, message, attrs, args) => {
      logs.push({ level, message, attrs, args });
    },
  });
  const connectListeners: ((event: MessageEvent) => void)[] = [];
  const closing = deferred<undefined>();
  const close = vi.fn<() => void>(() => {
    closing.resolve(undefined);
  });
  const scope: WorkerScope = {
    addEventListener: (_type, listener) => {
      connectListeners.push(listener);
    },
    close,
  };
  const open = vi.fn<SpanOpen>(() => ({
    setAttributes: () => undefined,
    child: () => {
      throw new Error('no child spans expected');
    },
    end: () => undefined,
  }));
  startProtocolWorker({
    scope,
    network: workerNetwork(name),
    lightClient: light.lightClient,
    resolver: light.resolver,
    openSpan: open,
    heartbeat,
    flush,
  });
  await light.presyncDone;
  return {
    connect: (port = fakePort()) => {
      for (const listener of connectListeners) {
        listener({ ports: [port.port] } as unknown as MessageEvent);
      }
      return port;
    },
    beat: () => {
      beat();
    },
    close,
    closed: closing.promise,
    closedOnce: closing.promise.then(afterQueuedTimers),
    logs,
    open,
  };
}

function chainConnect(id: string, connectionId: string): unknown {
  return relayRequest({ id, method: 'chainConnect', payload: { genesisHash: '0xaa', connectionId } });
}

function failToDeliver(port: FakePort, name: 'DataCloneError' | 'InvalidStateError'): void {
  port.posted.mockImplementationOnce(() => {
    throw new DOMException('could not deliver', name);
  });
}

/** Lets the heartbeat run until a silent port is let go. */
function outlastHeartbeat(worker: Worker): void {
  for (let i = 0; i <= HEARTBEAT_MISSED_BEATS; i++) {
    worker.beat();
  }
}

/** Answers each ping, as the iframe of a live tab does. */
function answerPings(port: FakePort): void {
  port.posted.mockImplementation(message => {
    if (isPing(message)) {
      port.receive({ type: 'pong' });
    }
  });
}

// The worker schedules its close on a zero-delay timer, and no message tells a test whether a second one is queued
// behind it. A timer queued after the first runs once every timer queued before it has.
const afterQueuedTimers = (): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, 0);
  });

/** What a port was told, less the heartbeat's pings. */
function heard(port: FakePort): unknown[] {
  return port.posted.mock.calls.map(([message]) => message).filter(message => !isPing(message));
}

function isPing(message: unknown): boolean {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'ping';
}

function envelopes(port: FakePort, kind: string): unknown[] {
  return heard(port)
    .filter(
      (message): message is { type: 'relay-response'; envelope: { kind: string } } =>
        (message as { type?: unknown }).type === 'relay-response',
    )
    .map(message => message.envelope)
    .filter(envelope => envelope.kind === kind);
}

function relayRequest(envelope: Partial<ProtocolRequestEnvelope>, resolutionId?: string): unknown {
  return {
    type: 'relay-request',
    envelope: { namespace: 'dotli:protocol', kind: 'request', id: 'r1', payload: {}, ...envelope },
    origin: 'https://dot.li',
    ...(resolutionId !== undefined ? { resolutionId } : {}),
  };
}

/** Whether the worker closed, and only after everything the port heard was posted. */
function closedAfterTelling(worker: Worker, port: FakePort): boolean {
  const closedAt = worker.close.mock.invocationCallOrder[0];
  return closedAt !== undefined && port.posted.mock.invocationCallOrder.every(order => order < closedAt);
}

const FATAL = 'chain 0xaa connection failed: wasm trap';

const fatalRelay = {
  type: 'relay-response',
  envelope: { namespace: 'dotli:protocol', kind: 'fatal', message: FATAL },
};

describe('protocol SharedWorker', () => {
  beforeEach(() => {
    captures.exception.mockClear();
  });

  it('As a dotli user on the shared light client, I hear that the light client died and the worker then closes, so my reconnect starts a fresh one', async () => {
    // Given a tab on a synced worker
    const light = fakeLightClient();
    const worker = await bootWorker(light);
    const tab = worker.connect();

    // When the light client cannot connect a chain, and the worker closes
    light.fatal(FATAL);
    await worker.closedOnce;

    // Then the tab heard the cause first, and the worker closed once
    expect(heard(tab)).toEqual([{ type: 'ready' }, fatalRelay]);
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(closedAfterTelling(worker, tab)).toBe(true);
  });

  it('As a dead shared worker, I send my buffered telemetry before I close', async () => {
    // Given a worker whose telemetry flush holds
    const light = fakeLightClient();
    const flushing = deferred<undefined>();
    const worker = await bootWorker(light, undefined, () => flushing.promise);
    worker.connect();

    // When the light client dies and the timers queued behind the fatal have run
    light.fatal(FATAL);
    await afterQueuedTimers();

    // Then the worker stays open while the flush holds, and closes once it is done
    expect(worker.close).not.toHaveBeenCalled();
    flushing.resolve(undefined);
    await worker.closedOnce;
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('As a dead shared worker, I close even when the flush gives up', async () => {
    // Given a worker whose telemetry flush fails
    const light = fakeLightClient();
    const worker = await bootWorker(light, undefined, () => Promise.reject(new Error('flush failed')));
    worker.connect();

    // When the light client dies
    light.fatal(FATAL);
    await worker.closedOnce;

    // Then the worker closed once
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user on the shared light client, I hear why pre-sync failed and the worker then closes, so my reconnect starts a fresh one', async () => {
    // Given a tab waiting on a pre-sync still under way
    const presync = deferred<undefined>();
    const worker = await bootWorker(fakeLightClient({ presync: () => presync.promise }));
    const waiting = worker.connect();

    // When pre-sync fails, and the worker closes
    presync.reject(new Error('chainHead follow stopped'));
    await worker.closedOnce;

    // Then the tab heard the cause first, and the worker closed once
    expect(heard(waiting)).toEqual([{ type: 'error', message: 'chainHead follow stopped' }]);
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(closedAfterTelling(worker, waiting)).toBe(true);
  });

  it('As a dotli user on the shared light client, I wait on a pre-sync the light client dies under and the worker closes once', async () => {
    // Given a tab waiting on a pre-sync still under way
    const presync = deferred<undefined>();
    const light = fakeLightClient({ presync: () => presync.promise });
    const worker = await bootWorker(light);
    const waiting = worker.connect();

    // When the light client cannot connect a chain, and pre-sync then fails for it
    light.fatal(FATAL);
    presync.reject(new Error('chainHead follow stopped'));
    await worker.closedOnce;

    // Then the tab heard only the fatal, and the worker closed once
    expect(heard(waiting)).toEqual([fatalRelay]);
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user whose pre-sync failed, I hear the light client die before the worker closes and the worker closes once', async () => {
    // Given a tab told that pre-sync failed, on a worker whose close is still to come
    const presync = deferred<undefined>();
    const light = fakeLightClient({ presync: () => presync.promise });
    const worker = await bootWorker(light);
    const tab = worker.connect();
    const told = new Promise<void>(resolve => {
      tab.posted.mockImplementationOnce(() => {
        resolve();
      });
    });
    presync.reject(new Error('chainHead follow stopped'));
    await told;

    // When the light client dies before that close, and the worker closes
    light.fatal(FATAL);
    await worker.closedOnce;

    // Then the tab heard both causes, and the worker closed once
    expect(heard(tab)).toEqual([{ type: 'error', message: 'chainHead follow stopped' }, fatalRelay]);
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user whose light client dies before my tab connected, I hear the failure at once and the worker then closes', async () => {
    // Given a worker whose light client died before the tab that started it connected
    const light = fakeLightClient({ presync: () => deferred<undefined>().promise });
    const worker = await bootWorker(light);
    light.fatal(FATAL);

    // When that tab connects, and the worker closes
    const tab = worker.connect();
    await worker.closedOnce;

    // Then it heard the fatal the worker latched, and the worker closed only after telling it
    expect(heard(tab)).toEqual([fatalRelay]);
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(closedAfterTelling(worker, tab)).toBe(true);
  });

  it('As dotli users in two tabs whose light client dies before either connected, we both hear the failure and the worker then closes once', async () => {
    // Given a worker whose light client died before any tab connected
    const light = fakeLightClient({ presync: () => deferred<undefined>().promise });
    const worker = await bootWorker(light);
    light.fatal(FATAL);

    // When two tabs whose connects were queued together connect, and the worker closes
    const first = worker.connect();
    const second = worker.connect();
    await worker.closedOnce;

    // Then both heard the fatal the worker latched, and the worker closed once after telling them
    expect(heard(first)).toEqual([fatalRelay]);
    expect(heard(second)).toEqual([fatalRelay]);
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(closedAfterTelling(worker, first)).toBe(true);
    expect(closedAfterTelling(worker, second)).toBe(true);
  });

  it('As a dotli user whose connect is queued when the light client dies under another tab, I hear the failure before the worker closes', async () => {
    // Given a tab on a synced worker
    const light = fakeLightClient();
    const worker = await bootWorker(light);
    const live = worker.connect();

    // When the light client dies while another tab's connect is queued behind it
    light.fatal(FATAL);
    const queued = worker.connect();
    await worker.closedOnce;

    // Then both tabs heard the cause, and the worker closed once after telling them
    expect(heard(live)).toEqual([{ type: 'ready' }, fatalRelay]);
    expect(heard(queued)).toEqual([fatalRelay]);
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(closedAfterTelling(worker, queued)).toBe(true);
  });

  it('As a dotli user whose pre-sync fails before my tab connected, I hear why at once and the worker then closes', async () => {
    // Given a worker whose pre-sync failed before the tab that started it connected
    const presync = deferred<undefined>();
    const worker = await bootWorker(fakeLightClient({ presync: () => presync.promise }));
    await endPresync(presync, new Error('chainHead follow stopped'));

    // When that tab connects, and the worker closes
    const tab = worker.connect();
    await worker.closedOnce;

    // Then it heard why pre-sync failed, and the worker closed only after telling it
    expect(heard(tab)).toEqual([{ type: 'error', message: 'chainHead follow stopped' }]);
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(closedAfterTelling(worker, tab)).toBe(true);
  });

  it('As a dotli user on the shared light client, I connect to a worker named for an unknown network and it stays up to tell me why', async () => {
    // Given a worker the iframe named for a network this build does not know
    const worker = await bootWorker(fakeLightClient(), 'dotli-protocol-nowhere');

    // When a tab connects
    const tab = worker.connect();

    // Then it hears the cause, and the worker does not close, since a fresh one would fail the same way
    expect(heard(tab)).toEqual([{ type: 'error', message: 'Unknown protocol network: "nowhere"' }]);
    expect(worker.close).not.toHaveBeenCalled();
  });

  it('As the shared worker named for a network this build does not know, I open no chain and report no sync', async () => {
    // Given
    const light = fakeLightClient();

    // When
    await bootWorker(light, 'dotli-protocol-nowhere');

    // Then
    expect(light.chains).toEqual([]);
    expect(light.syncReporting).toEqual([]);
  });

  it('As the shared worker, I serve the network my name carries and leave the config of this context to my entry', async () => {
    // Given a worker the iframe named for Previewnet
    const worker = await bootWorker(fakeLightClient(), 'dotli-protocol-previewnet');

    // When a tab connects
    const tab = worker.connect();

    // Then it is served, and the network this context reads is still its default
    expect(heard(tab)).toEqual([{ type: 'ready' }]);
    expect(getNetwork()).toBe('paseo-next-v2');
  });

  it('As a dotli user on the shared light client, I hear the stored database of each chain as the light client reads it', async () => {
    // Given a tab waiting on a pre-sync still under way
    const presync = deferred<undefined>();
    const light = fakeLightClient({ presync: () => presync.promise });
    const worker = await bootWorker(light);
    const tab = worker.connect();

    // When the light client reads the relay's database
    light.readDb('relay', 'miss');

    // Then the tab hears it
    expect(heard(tab)).toEqual([
      {
        type: 'relay-response',
        envelope: { namespace: 'dotli:protocol', kind: 'smoldot-db', chain: 'relay', outcome: 'miss' },
      },
    ]);
  });

  it('As a dotli user on the shared light client, I join while it syncs and hear what it read of each database so far', async () => {
    // Given a worker still syncing that already read the relay's database
    const presync = deferred<undefined>();
    const light = fakeLightClient({ presync: () => presync.promise });
    const worker = await bootWorker(light);
    light.readDb('relay', 'unavailable');

    // When a tab connects
    const tab = worker.connect();

    // Then it hears the read as it was, since it waits on the same sync
    expect(heard(tab)).toEqual([
      {
        type: 'relay-response',
        envelope: { namespace: 'dotli:protocol', kind: 'smoldot-db', chain: 'relay', outcome: 'unavailable' },
      },
    ]);
  });

  it('As a dotli user on the shared light client, I join a synced worker and hear every database it read as a hit', async () => {
    // Given a synced worker that found no stored relay
    const light = fakeLightClient();
    const worker = await bootWorker(light);
    light.readDb('relay', 'miss');

    // When a tab connects
    const tab = worker.connect();

    // Then this tab paid no sync cost
    expect(heard(tab)).toEqual([
      { type: 'ready' },
      {
        type: 'relay-response',
        envelope: { namespace: 'dotli:protocol', kind: 'smoldot-db', chain: 'relay', outcome: 'hit' },
      },
    ]);
  });

  it('As a dotli user on the shared light client, a tab that joins after the light client died hears why instead of ready', async () => {
    // Given a tab on a synced worker whose light client then cannot connect a chain
    const light = fakeLightClient();
    const worker = await bootWorker(light);
    const first = worker.connect();
    expect(first.posted).toHaveBeenCalledWith({ type: 'ready' });
    light.fatal(FATAL);

    // When another tab, or the same one after its retry, connects
    const later = worker.connect();

    // Then it is told the light client is dead, and never that it is ready
    expect(first.posted).toHaveBeenCalledWith(fatalRelay);
    expect(later.posted.mock.calls).toEqual([[fatalRelay]]);
  });

  it('As a dotli user on the shared light client, a light client that dies while Asset Hub syncs never tells a waiting tab it is ready', async () => {
    // Given a tab waiting on a pre-sync still under way
    const presync = deferred<undefined>();
    const light = fakeLightClient({ presync: () => presync.promise });
    const worker = await bootWorker(light);
    const waiting = worker.connect();

    // When the light client cannot connect a chain, and then Asset Hub syncs anyway
    light.fatal(FATAL);
    await endPresync(presync);
    const later = worker.connect();

    // Then the waiting tab heard only the fatal, and the engine never became ready
    expect(heard(waiting)).toEqual([fatalRelay]);
    expect(later.posted.mock.calls).toEqual([[fatalRelay]]);
    expect(light.peopleWarms).toBe(0);
  });

  it('As a dotli user on the shared light client, a tab waiting on pre-sync is told why the light client died, once', async () => {
    // Given a tab waiting on a pre-sync still under way
    const presync = deferred<undefined>();
    const light = fakeLightClient({ presync: () => presync.promise });
    const worker = await bootWorker(light);
    const waiting = worker.connect();

    // When the light client cannot connect a chain, and pre-sync then fails for it
    light.fatal(FATAL);
    presync.reject(new Error('chainHead follow stopped'));
    await worker.closed;
    const later = worker.connect();

    // Then both tabs hear the cause, not its symptom, and the waiting one only once
    expect(heard(waiting)).toEqual([fatalRelay]);
    expect(later.posted.mock.calls).toEqual([[fatalRelay]]);
  });

  it('As a dotli user on the shared light client, a tab that closes while pre-sync runs is not told it finished', async () => {
    // Given a tab waiting on a pre-sync still under way
    const presync = deferred<undefined>();
    const worker = await bootWorker(fakeLightClient({ presync: () => presync.promise }));
    const leaving = worker.connect();
    const staying = worker.connect();

    // When the tab unloads, and pre-sync then completes
    leaving.receive({ type: 'disconnect' });
    await endPresync(presync);

    // Then the closed port heard nothing, while the tab that stayed heard it is ready
    expect(heard(staying)).toEqual([{ type: 'ready' }]);
    expect(heard(leaving)).toEqual([]);
  });

  it("As a dotli user on the shared light client, my tab's loading screen hears how the shared chains sync", async () => {
    // Given a tab waiting on a pre-sync still under way
    const light = fakeLightClient({ presync: () => new Promise<void>(() => undefined) });
    const worker = await bootWorker(light);
    const waiting = worker.connect();

    // When the relay reports its warp progress
    const progress: ChainSyncEvent = { chain: 'relay', kind: 'warpSyncProgress', at: 10, target: 100 };
    for (const listener of light.syncListeners) {
      listener(progress);
    }

    // Then the tab hears it as the envelope direct mode sends
    expect(envelopes(waiting, 'chain-sync')).toEqual([
      {
        namespace: 'dotli:protocol',
        kind: 'chain-sync',
        chain: 'relay',
        syncKind: 'warpSyncProgress',
        at: 10,
        target: 100,
      },
    ]);
  });

  it("As a dotli user on the shared light client, I resolve names over the light client's own Asset Hub and People follows", async () => {
    // Given
    const light = fakeLightClient();
    await bootWorker(light);
    const deps = must(light.dotnsDeps, 'resolver deps');
    const services = getActiveServicesConfig();

    // When
    deps.assetHub()(() => undefined);
    must(deps.people, 'people')()(() => undefined);

    // Then
    expect(light.chains).toEqual([
      services.relay.genesis,
      services.bulletin.genesis,
      services.assethub.genesis,
      services.people.genesis,
    ]);
    expect(deps.dotns).toEqual(services.dotns);
  });

  it('As a dotli user on the shared light client, the relay and Bulletin sync shows before any product asks for them', async () => {
    // Given
    const light = fakeLightClient();
    const services = getActiveServicesConfig();

    // When
    await bootWorker(light);

    // Then sync reporting is on before the first chain opens, and the relay and Bulletin open with nothing asking
    expect(light.syncReporting).toEqual([{ chains: ['relay', 'assethub', 'bulletin', 'people'], openBefore: 0 }]);
    expect(light.chains).toEqual([services.relay.genesis, services.bulletin.genesis]);
  });

  it('As a dotli user on the shared light client, a tab that joins a synced worker hears where the chains stand, and that it started warm', async () => {
    // Given a synced worker whose own first start found Asset Hub cold on disk
    const worker = await bootWorker(
      fakeLightClient({
        sync: [{ chain: 'assethub', kind: 'bootstrapComplete' }],
        detail: [{ chain: 'assethub', dbCache: 'miss' }],
      }),
    );

    // When another tab connects
    const later = worker.connect();

    // Then it hears the chain is up, and pays no sync cost for it
    expect(envelopes(later, 'chain-sync')).toEqual([
      { namespace: 'dotli:protocol', kind: 'chain-sync', chain: 'assethub', syncKind: 'bootstrapComplete' },
    ]);
    expect(envelopes(later, 'chain-detail')).toEqual([
      { namespace: 'dotli:protocol', kind: 'chain-detail', chain: 'assethub', dbCache: 'hit' },
    ]);
  });

  it('As a dotli user on the shared light client, a closed tab stops hearing chain sync', async () => {
    // Given a tab on a synced worker
    const light = fakeLightClient();
    const worker = await bootWorker(light);
    const leaving = worker.connect();
    const staying = worker.connect();

    // When the tab unloads, and the relay then reports its warp progress
    leaving.receive({ type: 'disconnect' });
    for (const listener of light.syncListeners) {
      listener({ chain: 'relay', kind: 'warpSyncProgress', at: 10, target: 100 });
    }

    // Then the tab that stayed heard it, and the one that left did not
    expect(envelopes(staying, 'chain-sync')).toHaveLength(1);
    expect(envelopes(leaving, 'chain-sync')).toEqual([]);
  });

  it('As a dotli maintainer, a failed request tells the host where it was thrown', async () => {
    // Given a tab on a worker whose name resolution fails
    const failure = new Error('storage read failed');
    const worker = await bootWorker(fakeLightClient({ resolveDotName: () => Promise.reject(failure) }));
    const tab = worker.connect();

    // When the tab asks to resolve a name
    await ask(tab, relayRequest({ method: 'resolveDotName', payload: { label: 'doom' } }));

    // Then the error response carries the failure's name and stack
    expect(envelopes(tab, 'response')).toEqual([
      {
        namespace: 'dotli:protocol',
        kind: 'response',
        id: 'r1',
        ok: false,
        error: 'storage read failed',
        errorName: 'Error',
        errorStack: failure.stack?.slice(0, 2000),
      },
    ]);
  });

  it("As a dotli maintainer, the worker's span for a request carries the page load of the tab that sent it", async () => {
    // Given a tab on a synced worker
    const worker = await bootWorker(fakeLightClient());
    const tab = worker.connect();

    // When it sends a request with a resolution id, and one with a malformed id
    await ask(tab, relayRequest({ method: 'resolveDotName', payload: { label: 'doom' } }, 'load-1'));
    await ask(tab, relayRequest({ id: 'r2', method: 'warmup' }, 'not a resolution id!'));

    // Then only a well-formed id is recorded, and only on that request's span
    expect(worker.open.mock.calls).toEqual([
      ['protocol.worker_request', { root: true, attributes: { method: 'resolveDotName', resolution_id: 'load-1' } }],
      ['protocol.worker_request', { root: true, attributes: { method: 'warmup' } }],
    ]);
  });

  it('As a dotli maintainer, a message the worker cannot deliver to a tab is reported, since the host never hears of it', async () => {
    // Given a tab whose responses cannot be cloned
    const worker = await bootWorker(fakeLightClient());
    const tab = worker.connect();
    const failure = new DOMException('could not be cloned', 'DataCloneError');
    tab.posted.mockImplementation(message => {
      if ((message as { type?: unknown }).type === 'relay-response') {
        throw failure;
      }
    });

    // When it sends a request
    await ask(tab, relayRequest({ method: 'warmup' }));

    // Then the failed send is captured with what it carried
    expect(captures.exception).toHaveBeenCalledWith(failure, {
      flow: 'protocol',
      step: 'worker_port_send',
      tags: { envelope_kind: 'response' },
    });
  });

  it('As a dotli user with two tabs on one worker, a tab that closed cannot open connections, and the other tab keeps its own', async () => {
    // Given two tabs that each hold a chain connection
    const light = fakeLightClient();
    const worker = await bootWorker(light);
    const leaving = worker.connect();
    const staying = worker.connect();
    const connect = relayRequest({ method: 'chainConnect', payload: { genesisHash: '0xaa', connectionId: 'c1' } });
    await Promise.all([ask(leaving, connect), ask(staying, connect)]);

    // When the first tab closes, and a late request from it still arrives
    leaving.receive({ type: 'disconnect' });
    await ask(
      leaving,
      relayRequest({ id: 'r2', method: 'chainConnect', payload: { genesisHash: '0xaa', connectionId: 'c2' } }),
    );

    // Then the late request is refused, and the shared chain stays up for the other tab
    expect(envelopes(leaving, 'response')).toMatchObject([
      { id: 'r1', ok: true },
      { id: 'r2', ok: false },
    ]);
    // And neither the observed relay and Bulletin nor the tabs' shared chain is let go
    expect(light.disconnects).toHaveLength(3);
    for (const disconnect of light.disconnects) {
      expect(disconnect).not.toHaveBeenCalled();
    }

    // And the other tab's connection still carries its requests
    await ask(
      staying,
      relayRequest({ id: 'r3', method: 'chainSend', payload: { connectionId: 'c1', message: '{"jsonrpc":"2.0"}' } }),
    );
    expect(envelopes(staying, 'response')).toMatchObject([
      { id: 'r1', ok: true },
      { id: 'r3', ok: true },
    ]);
  });

  it('As a dotli user on the shared light client, a tab that stopped answering is let go and told its connections halted', async () => {
    // Given a tab holding a chain connection
    const worker = await bootWorker(fakeLightClient());
    const tab = worker.connect();
    await ask(tab, chainConnect('r1', 'c1'));

    // When it answers no ping for longer than the heartbeat allows
    outlastHeartbeat(worker);

    // Then it is let go, and a tab that was only frozen hears its connection is gone
    expect(envelopes(tab, 'chain-halt')).toEqual([
      { namespace: 'dotli:protocol', kind: 'chain-halt', connectionId: 'c1' },
    ]);
  });

  it('As a dotli user on the shared light client, a tab that answers every ping keeps its connections', async () => {
    // Given a live tab holding a chain connection
    const worker = await bootWorker(fakeLightClient());
    const tab = worker.connect();
    await ask(tab, chainConnect('r1', 'c1'));
    answerPings(tab);

    // When many heartbeats pass
    for (let i = 0; i < 3 * HEARTBEAT_MISSED_BEATS; i++) {
      worker.beat();
    }

    // Then it was never let go
    expect(envelopes(tab, 'chain-halt')).toEqual([]);
  });

  it('As a dotli user on the shared light client, a frozen tab that wakes after it was let go is served again', async () => {
    // Given a tab the heartbeat let go
    const worker = await bootWorker(fakeLightClient());
    const tab = worker.connect();
    outlastHeartbeat(worker);

    // When it wakes and connects a chain
    await ask(tab, chainConnect('r2', 'c2'));

    // Then it is served, and not told it is ready a second time
    expect(envelopes(tab, 'response')).toEqual([
      { namespace: 'dotli:protocol', kind: 'response', id: 'r2', ok: true, result: true },
    ]);
    expect(heard(tab).filter(message => (message as { type?: unknown }).type === 'ready')).toHaveLength(1);
  });

  it('As a dotli user on the shared light client, a tab let go while pre-sync ran is told it is ready when it wakes after', async () => {
    // Given a tab the heartbeat let go while pre-sync was still under way
    const presync = deferred<undefined>();
    const light = fakeLightClient({ presync: () => presync.promise });
    const worker = await bootWorker(light);
    const tab = worker.connect();
    outlastHeartbeat(worker);
    await endPresync(presync);
    expect(heard(tab)).toEqual([]);
    expect(light.peopleWarms).toBe(1);

    // When it wakes and answers the next ping
    tab.receive({ type: 'pong' });

    // Then it is served again, and hears the ready it missed, once
    expect(heard(tab)).toEqual([{ type: 'ready' }]);
  });

  it('As a dotli user with a tab frozen during pre-sync, I wake and hear each chain database the light client read while I was gone, once', async () => {
    // Given a tab that heard the relay's database, then was let go by the heartbeat while pre-sync ran
    const presync = deferred<undefined>();
    const light = fakeLightClient({ presync: () => presync.promise });
    const worker = await bootWorker(light);
    const tab = worker.connect();
    light.readDb('relay', 'hit');
    outlastHeartbeat(worker);

    // When the light client reads Asset Hub's database while the tab is gone, and the tab talks again
    light.readDb('assethub', 'miss');
    tab.receive({ type: 'pong' });

    // Then the tab heard each database once, the one it missed with its real outcome
    expect(envelopes(tab, 'smoldot-db')).toEqual([
      { namespace: 'dotli:protocol', kind: 'smoldot-db', chain: 'relay', outcome: 'hit' },
      { namespace: 'dotli:protocol', kind: 'smoldot-db', chain: 'assethub', outcome: 'miss' },
    ]);
  });

  it('As a dotli maintainer, a tab the fatal could not reach is reported once', async () => {
    // Given a tab whose port fails every send with a clone error
    const light = fakeLightClient();
    const worker = await bootWorker(light);
    const tab = worker.connect();
    tab.posted.mockImplementation(() => {
      throw new DOMException('could not clone', 'DataCloneError');
    });

    // When the light client dies
    light.fatal(FATAL);

    // Then the fatal was tried on that tab once, and reported once
    expect(heard(tab).filter(message => (message as { type?: unknown }).type === 'relay-response')).toEqual([
      fatalRelay,
    ]);
    expect(captures.exception).toHaveBeenCalledTimes(1);
  });

  it('As a dotli maintainer, a waiting tab that pre-sync failure could not reach is tried once and reported once', async () => {
    // Given a tab waiting on pre-sync whose port fails every send with a clone error
    const presync = deferred<undefined>();
    const worker = await bootWorker(fakeLightClient({ presync: () => presync.promise }));
    const tab = worker.connect();
    tab.posted.mockImplementation(() => {
      throw new DOMException('could not clone', 'DataCloneError');
    });

    // When pre-sync fails
    await endPresync(presync, new Error('chainHead follow stopped'));

    // Then the cause was tried on that tab once, and the failed send reported once
    expect(heard(tab)).toEqual([{ type: 'error', message: 'chainHead follow stopped' }]);
    expect(captures.exception).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user with a tab frozen during pre-sync, I wake after ready and hear the cold database and a chain detail that agrees with it', async () => {
    // Given a tab let go by the heartbeat while pre-sync ran, and an Asset Hub found cold on disk while it was gone
    const presync = deferred<undefined>();
    const light = fakeLightClient({ presync: () => presync.promise });
    const worker = await bootWorker(light);
    const tab = worker.connect();
    outlastHeartbeat(worker);
    light.readDb('assethub', 'miss');
    light.detail.push({ chain: 'assethub', dbCache: 'miss' });
    await endPresync(presync);

    // When the tab talks again after the worker is ready
    tab.receive({ type: 'pong' });

    // Then it hears the miss it waited through, in the database outcome and the chain detail alike
    expect(envelopes(tab, 'smoldot-db')).toEqual([
      { namespace: 'dotli:protocol', kind: 'smoldot-db', chain: 'assethub', outcome: 'miss' },
    ]);
    expect(envelopes(tab, 'chain-detail')).toEqual([
      { namespace: 'dotli:protocol', kind: 'chain-detail', chain: 'assethub', dbCache: 'miss' },
    ]);
  });

  it('As a dotli user on the shared light client, a tab the worker once failed to reach is served on its next request', async () => {
    // Given a tab one response could not be delivered to
    const worker = await bootWorker(fakeLightClient());
    const tab = worker.connect();
    failToDeliver(tab, 'DataCloneError');
    await ask(tab, relayRequest({ method: 'warmup' }));

    // When it sends another request
    await ask(tab, chainConnect('r2', 'c2'));

    // Then it is served
    expect(envelopes(tab, 'response').at(-1)).toEqual({
      namespace: 'dotli:protocol',
      kind: 'response',
      id: 'r2',
      ok: true,
      result: true,
    });
  });

  it('As a dotli user on the shared light client, a tab that said it was leaving stays refused, and the refusal is no failure', async () => {
    // Given a tab that unloaded
    const light = fakeLightClient();
    const services = getActiveServicesConfig();
    const worker = await bootWorker(light);
    const tab = worker.connect();
    tab.receive({ type: 'disconnect' });

    // When a pong and a late request from it still arrive
    tab.receive({ type: 'pong' });
    await ask(tab, chainConnect('r2', 'c2'));

    // Then it is refused without a request span or a warning, and opens nothing
    expect(envelopes(tab, 'response')).toMatchObject([{ id: 'r2', ok: false, error: PROTOCOL_APP_ERRORS.PORT_CLOSED }]);
    expect(worker.open).not.toHaveBeenCalled();
    expect(worker.logs.filter(line => line.level === 'warn')).toEqual([]);
    // Nothing past the two observed chains opened.
    expect(light.chains).toEqual([services.relay.genesis, services.bulletin.genesis]);
  });

  it('As a dotli user on the shared light client, a tab whose port closed stays refused', async () => {
    // Given a tab whose port closed under a response
    const light = fakeLightClient();
    const services = getActiveServicesConfig();
    const worker = await bootWorker(light);
    const tab = worker.connect();
    failToDeliver(tab, 'InvalidStateError');
    await ask(tab, relayRequest({ method: 'warmup' }));

    // When a late request from it still arrives
    await ask(tab, chainConnect('r2', 'c2'));

    // Then it is refused, and opens nothing
    expect(envelopes(tab, 'response').at(-1)).toMatchObject({
      id: 'r2',
      ok: false,
      error: PROTOCOL_APP_ERRORS.PORT_CLOSED,
    });
    // Nothing past the two observed chains opened.
    expect(light.chains).toEqual([services.relay.genesis, services.bulletin.genesis]);
  });

  it('As a dotli user with two tabs on one worker, a tab the worker cannot tell it is ready does not keep the other from hearing it', async () => {
    // Given two tabs waiting on a pre-sync still under way, the first one unreachable
    const presync = deferred<undefined>();
    const worker = await bootWorker(fakeLightClient({ presync: () => presync.promise }));
    const unreachable = worker.connect();
    const waiting = worker.connect();
    failToDeliver(unreachable, 'DataCloneError');

    // When pre-sync completes
    await endPresync(presync);

    // Then the other tab hears it is ready, and the healthy worker stays up
    expect(heard(waiting)).toEqual([{ type: 'ready' }]);
    expect(worker.close).not.toHaveBeenCalled();
  });

  it('As a dotli user on the shared light client, a tab whose chain replay could not be delivered is not told it is ready', async () => {
    // Given a tab whose first chain-sync replay fails to deliver while pre-sync runs
    const presync = deferred<undefined>();
    const worker = await bootWorker(
      fakeLightClient({ presync: () => presync.promise, sync: [{ chain: 'assethub', kind: 'bootstrapComplete' }] }),
    );
    const tab = fakePort();
    failToDeliver(tab, 'DataCloneError');
    worker.connect(tab);

    // When pre-sync completes
    await endPresync(presync);

    // Then the port the worker let go hears nothing more
    expect(tab.posted).not.toHaveBeenCalledWith({ type: 'ready' });
  });

  it('As a dotli user on the shared light client, a tab one response could not reach hears its connections halted', async () => {
    // Given a tab holding a chain connection
    const worker = await bootWorker(fakeLightClient());
    const tab = worker.connect();
    await ask(tab, chainConnect('r1', 'c1'));

    // When one response to it cannot be delivered
    failToDeliver(tab, 'DataCloneError');
    await ask(tab, relayRequest({ id: 'r2', method: 'warmup' }));

    // Then it hears its connection is gone, so it reconnects when it is served again
    expect(envelopes(tab, 'chain-halt')).toEqual([
      { namespace: 'dotli:protocol', kind: 'chain-halt', connectionId: 'c1' },
    ]);
  });

  it('As a dotli user with a frozen tab, I hear that the light client died even after the heartbeat let me go, so my host rebuilds the frame when I thaw', async () => {
    // Given a live tab, and a frozen one the heartbeat let go
    const light = fakeLightClient();
    const worker = await bootWorker(light);
    const live = worker.connect();
    answerPings(live);
    const frozen = worker.connect();
    outlastHeartbeat(worker);

    // When the light client dies, and the worker closes
    light.fatal(FATAL);
    await worker.closed;

    // Then both tabs heard the cause before the worker closed
    expect(heard(live)).toEqual([{ type: 'ready' }, fatalRelay]);
    expect(heard(frozen)).toEqual([{ type: 'ready' }, fatalRelay]);
    expect(closedAfterTelling(worker, frozen)).toBe(true);
  });

  it('As a dotli user with a frozen tab, I hear why pre-sync failed even after the heartbeat let me go', async () => {
    // Given a tab the heartbeat let go while pre-sync was still under way
    const presync = deferred<undefined>();
    const worker = await bootWorker(fakeLightClient({ presync: () => presync.promise }));
    const frozen = worker.connect();
    outlastHeartbeat(worker);

    // When pre-sync fails, and the worker closes
    presync.reject(new Error('chainHead follow stopped'));
    await worker.closed;

    // Then the tab heard the cause before the worker closed
    expect(heard(frozen)).toEqual([{ type: 'error', message: 'chainHead follow stopped' }]);
    expect(closedAfterTelling(worker, frozen)).toBe(true);
  });

  it('As a dotli user with a frozen tab, I say I am leaving after the heartbeat let me go and hear nothing more', async () => {
    // Given a tab the heartbeat let go, which then unloads
    const light = fakeLightClient();
    const worker = await bootWorker(light);
    const leaving = worker.connect();
    outlastHeartbeat(worker);
    leaving.receive({ type: 'disconnect' });

    // When the light client dies
    light.fatal(FATAL);

    // Then the tab that left heard only the ready from before
    expect(heard(leaving)).toEqual([{ type: 'ready' }]);
  });

  it('As a dotli user with a frozen tab, I say I am leaving after the heartbeat let me go and a late request of mine is refused', async () => {
    // Given a tab the heartbeat let go, which then unloads
    const light = fakeLightClient();
    const services = getActiveServicesConfig();
    const worker = await bootWorker(light);
    const leaving = worker.connect();
    outlastHeartbeat(worker);
    leaving.receive({ type: 'disconnect' });

    // When a late request from it still arrives
    await ask(leaving, chainConnect('r2', 'c2'));

    // Then it is refused, and opens nothing
    expect(envelopes(leaving, 'response')).toMatchObject([
      { id: 'r2', ok: false, error: PROTOCOL_APP_ERRORS.PORT_CLOSED },
    ]);
    // Nothing past the two observed chains opened.
    expect(light.chains).toEqual([services.relay.genesis, services.bulletin.genesis]);
  });

  it('As a dotli user on the shared light client, a worker whose light client died stops its heartbeat', async () => {
    // Given a tab on a synced worker
    const light = fakeLightClient();
    const worker = await bootWorker(light);
    const tab = worker.connect();

    // When the light client dies and the worker closes
    light.fatal(FATAL);
    await worker.closedOnce;
    tab.posted.mockClear();
    outlastHeartbeat(worker);

    // Then no beat runs after the close
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(tab.posted).not.toHaveBeenCalled();
  });

  it('As a dotli user on the shared light client, a busy tab that never answers a ping keeps its port', async () => {
    // Given a tab holding a chain connection whose iframe does not answer pings
    const worker = await bootWorker(fakeLightClient());
    const tab = worker.connect();
    await ask(tab, chainConnect('r0', 'c1'));

    // When it sends a request every beat
    for (let i = 1; i <= 3 * HEARTBEAT_MISSED_BEATS; i++) {
      tab.receive(relayRequest({ id: `r${String(i)}`, method: 'warmup' }));
      worker.beat();
    }
    await ask(tab, relayRequest({ id: 'last', method: 'warmup' }));

    // Then its connection was never halted, and a later request is served
    expect(envelopes(tab, 'chain-halt')).toEqual([]);
    expect(envelopes(tab, 'response').at(-1)).toMatchObject({ id: 'last', ok: true });
  });
});

describe('workerNetwork', () => {
  it('As the shared worker, I read the network from the name the iframe gave me', () => {
    // When
    const network = workerNetwork('dotli-protocol-previewnet');

    // Then
    expect(network).toEqual({ ok: true, network: 'previewnet' });
  });

  it('As the shared worker named for a network this build does not know, I say which one', () => {
    // When
    const network = workerNetwork('dotli-protocol-nowhere');

    // Then
    expect(network).toEqual({ ok: false, message: 'Unknown protocol network: "nowhere"' });
  });

  it('As the shared worker named without a network, I say the iframe did not encode one', () => {
    // When
    const network = workerNetwork('dotli-protocol');

    // Then
    expect(network).toEqual({
      ok: false,
      message: 'Unexpected SharedWorker name "dotli-protocol" — iframe did not encode the active network.',
    });
  });
});
