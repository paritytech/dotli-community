// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The light client and the resolver functions the worker is given are fakes, and the worker global is a fake scope.
// Each tab is a real consumer transport on its own port pair, so the worker is driven over the wire as an iframe
// drives it.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { deferred, manualTimers, must } from '@dotli/shared/testing';
import type { JsonRpcConnection } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig, getNetwork } from '@dotli/config';
import { bindCaptureSink, spans as S, type m } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createConsumerTransport, createPortProvider, type ConsumerTransport } from '@dotli/protocol';
import type { LightClient, LightClientChange, SmoldotDbChain, SmoldotDbOutcome } from '@dotli/chains';
import { bindLogSink, type LogLevel } from '@dotli/shared';
import type { Ticker } from './net-bytes.js';
import {
  startProtocolWorker,
  workerNetwork,
  type HeartbeatClock,
  type WorkerResolver,
  type WorkerScope,
} from './protocol-worker.js';
import { createFrameStatus } from './frame-status.js';
import { connectSharedWorker, type SharedWorkerLinkDeps } from './shared-worker-link.js';
import { closeHostLinks, linkHost, record, type Recording } from './testing/host-link.js';
import { registerWorkerRelay } from './worker-relay.js';
import { HEARTBEAT_MISSED_BEATS } from './worker-messages.js';

type ChainSyncEvent = Parameters<Parameters<WorkerResolver['onChainSync']>[0]>[0];
type ChainDetail = Parameters<Parameters<WorkerResolver['onChainDetail']>[0]>[0];
type DotnsResolverDeps = Parameters<WorkerResolver['createDotnsResolver']>[0];
type SpanOpen = typeof m.open;

const captures = { exception: vi.fn(), expected: vi.fn() };
bindCaptureSink(captures);

interface LogLine {
  level: LogLevel;
  message: string;
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
  /** Settles once no more than `count` listeners hear chain sync. */
  untilSyncListeners: (count: number) => Promise<void>;
  /** The disconnect of each chain the worker opened, in order. */
  disconnects: Mock<() => void>[];
  /** The genesis hash of each chain the worker opened, in order. */
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
  const syncWaiters: { count: number; resolve: () => void }[] = [];
  let fatal: string | null = null;
  const defaultPresync = Promise.resolve();
  const tell = (change: LightClientChange): void => {
    for (const listener of [...listeners]) {
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
    untilSyncListeners: count =>
      light.syncListeners.size <= count
        ? Promise.resolve()
        : new Promise(resolve => {
            syncWaiters.push({ count, resolve });
          }),
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
        for (const waiter of syncWaiters.filter(w => light.syncListeners.size <= w.count)) {
          syncWaiters.splice(syncWaiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      };
    },
    onChainDetail: cb => {
      light.detail.forEach(cb);
      return () => undefined;
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

/** A tab's protocol iframe, linked to the worker over its own port. */
interface Tab {
  transport: ConsumerTransport;
  /** The worker's status as the tab hears it, subscribed on connect as an iframe does. */
  status: Recording<'frameStatus'>;
  /** Every buffer the worker posted to this tab, as it was before the transfer detached it. */
  posted: ArrayBuffer[];
  /** How many times the worker closed its end of this tab's port. */
  closes: () => number;
}

const openPorts = new Set<MessagePort>();
const tabs = new Set<ConsumerTransport>();

afterEach(() => {
  const over = new Error('The spec is over');
  for (const transport of tabs) {
    transport.dispose(over);
  }
  tabs.clear();
  closeHostLinks();
  for (const port of openPorts) {
    port.close();
  }
  openPorts.clear();
});

type Presync = ReturnType<typeof deferred<undefined>>;

/**
 * Ends a held pre-sync and settles once the worker has acted on it. The worker awaited that promise before the test
 * did, so its continuation has run by then.
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
  /** A tab's iframe connects, telling the worker its page load. */
  connect: (resolutionId?: string) => Tab;
  /** A tab's port reaches the worker, and its iframe speaks once the test says so. */
  attach: () => Attached;
  /** One heartbeat interval passes, if the worker has not stopped its heartbeat. */
  beat: () => void;
  /** Whether the worker's heartbeat runs. */
  beating: () => boolean;
  /** One byte-report interval passes for every running report. */
  tickNetBytes: () => void;
  close: Mock<() => void>;
  closed: Promise<void>;
  /** Settles one timer turn after the worker closes, so a second close scheduled alongside the first has run too. */
  closedOnce: Promise<void>;
  logs: LogLine[];
  /** Settles once the worker has logged `message`. */
  untilLog: (message: string) => Promise<void>;
  open: Mock<SpanOpen>;
}

/**
 * The worker's end of a port, spying on each buffer it posts before the transfer detaches it, and calling `received`
 * after the worker handled each message the tab sent.
 */
function spiedPort(port: MessagePort, posted: ArrayBuffer[], received: () => void, closed: () => void): MessagePort {
  const wrapped = new Map<EventListener, EventListener>();
  return {
    postMessage: (data: ArrayBuffer, transfer: Transferable[]) => {
      posted.push(data);
      port.postMessage(data, transfer);
    },
    addEventListener: (type: string, listener: EventListener) => {
      const wrapper: EventListener = event => {
        listener(event);
        received();
      };
      wrapped.set(listener, wrapper);
      port.addEventListener(type, wrapper);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      port.removeEventListener(type, wrapped.get(listener) ?? listener);
    },
    start: port.start.bind(port),
    close: () => {
      closed();
      port.close();
    },
  } as unknown as MessagePort;
}

/** A tab's port that reached the worker, before its iframe speaks. */
interface Attached {
  /** The iframe speaks through a bare transport, as the specs drive it. */
  speak: (resolutionId?: string) => Tab;
  /**
   * The iframe speaks through its real link, whose timers never run, as in a page hidden for long. Given `onOpen`, the
   * link hands it the transport and the worker status, as the iframe's relay takes them.
   */
  link: (onOpen?: SharedWorkerLinkDeps['onOpen']) => Promise<ConsumerTransport>;
  /** Settles once the worker handled the next message from this tab. */
  nextReceived: () => Promise<void>;
}

/**
 * Starts a worker on a fake scope, as the browser does when the first tab names it. Settles once the worker has acted
 * on a pre-sync that is already done, as it awaited that promise first.
 */
async function bootWorker(
  light: FakeLightClient,
  name = 'dotli-protocol-paseo-next-v2',
  flush: () => Promise<void> = () => Promise.resolve(),
  readNetBytes?: () => number,
): Promise<Worker> {
  let beat: (() => void) | null = null;
  const heartbeat: HeartbeatClock = {
    start: onBeat => {
      beat = onBeat;
      return () => {
        beat = null;
      };
    },
  };
  const ticks = new Set<() => void>();
  const netBytesTicker: Ticker = onTick => {
    ticks.add(onTick);
    return () => {
      ticks.delete(onTick);
    };
  };
  const logs: LogLine[] = [];
  const logWaiters: { message: string; resolve: () => void }[] = [];
  bindLogSink({
    emit: (level, message) => {
      logs.push({ level, message });
      for (const waiter of logWaiters.filter(w => w.message === message)) {
        logWaiters.splice(logWaiters.indexOf(waiter), 1);
        waiter.resolve();
      }
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
    ...(readNetBytes === undefined ? {} : { netBytes: { read: readNetBytes, ticker: netBytesTicker } }),
  });
  await light.presyncDone;
  const attach = (): Attached => {
    const channel = new MessageChannel();
    openPorts.add(channel.port1);
    openPorts.add(channel.port2);
    const posted: ArrayBuffer[] = [];
    let closes = 0;
    let waiting: (() => void)[] = [];
    const received = (): void => {
      const due = waiting;
      waiting = [];
      for (const resolve of due) {
        resolve();
      }
    };
    for (const listener of connectListeners) {
      listener({
        ports: [
          spiedPort(channel.port1, posted, received, () => {
            closes += 1;
          }),
        ],
      } as unknown as MessageEvent);
    }
    return {
      speak: resolutionId => {
        const transport = createConsumerTransport(createPortProvider(channel.port2), {
          side: 'frame',
          count: () => 0,
          ...(resolutionId === undefined ? {} : { resolutionId }),
        });
        transport.connect();
        tabs.add(transport);
        return { transport, status: record(transport, 'frameStatus', undefined), posted, closes: () => closes };
      },
      link: async onOpen => {
        const transport = await connectSharedWorker({
          worker: { port: channel.port2, addEventListener: () => undefined },
          window: new EventTarget(),
          resolutionId: null,
          readyTimeoutMs: 30_000,
          timers: manualTimers(),
          ...(onOpen === undefined ? {} : { onOpen }),
        });
        tabs.add(transport);
        return transport;
      },
      nextReceived: () =>
        new Promise(resolve => {
          waiting.push(resolve);
        }),
    };
  };
  return {
    connect: resolutionId => attach().speak(resolutionId),
    attach,
    beat: () => {
      beat?.();
    },
    beating: () => beat !== null,
    tickNetBytes: () => {
      for (const tick of [...ticks]) {
        tick();
      }
    },
    close,
    closed: closing.promise,
    closedOnce: closing.promise.then(afterQueuedTimers),
    logs,
    untilLog: message =>
      logs.some(line => line.message === message)
        ? Promise.resolve()
        : new Promise(resolve => {
            logWaiters.push({ message, resolve });
          }),
    open,
  };
}

/** Lets the heartbeat run until a silent port is let go. */
function outlastHeartbeat(worker: Worker): void {
  for (let i = 0; i <= HEARTBEAT_MISSED_BEATS; i++) {
    worker.beat();
  }
}

// The worker schedules its close on a zero-delay timer, and no message tells a test whether a second one is queued
// behind it. A timer queued after the first runs once every timer queued before it has.
const afterQueuedTimers = (): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, 0);
  });

/** Connects a chain on the tab and settles once the worker answered it is connected. */
async function connectChain(tab: Tab, connectionId: string): Promise<Recording<'chainConnect'>> {
  const chain = record(tab.transport, 'chainConnect', { genesisHash: '0xaa', connectionId });
  await chain.until(1);
  return chain;
}

/** The tab's status, once the worker said it is ready. */
async function readyStatus(tab: Tab): Promise<Recording<'frameStatus'>> {
  await tab.status.until(1);
  return tab.status;
}

const FATAL = 'chain 0xaa connection failed: wasm trap';

const fatalEnd = { name: 'ProtocolFatalError', message: FATAL };

describe('protocol SharedWorker', () => {
  beforeEach(() => {
    captures.exception.mockClear();
  });

  it('As a dotli user on the shared light client, I hear that the light client died and the worker then closes, so my reconnect starts a fresh one', async () => {
    // Given a tab on a synced worker
    const light = fakeLightClient();
    const worker = await bootWorker(light);
    const status = await readyStatus(worker.connect());

    // When the light client cannot connect a chain, and the worker closes
    light.fatal(FATAL);
    await worker.closedOnce;

    // Then the tab heard the cause, and the worker closed once
    await expect(status.ended).resolves.toMatchObject(fatalEnd);
    expect(worker.close).toHaveBeenCalledTimes(1);
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
    const status = worker.connect().status;

    // When pre-sync fails, and the worker closes
    presync.reject(new Error('chainHead follow stopped'));
    await worker.closedOnce;

    // Then the tab heard the cause as a failed init, and the worker closed once
    await expect(status.ended).resolves.toMatchObject({
      name: 'ProtocolInitFailedError',
      message: 'chainHead follow stopped',
    });
    expect(status.events).toEqual([]);
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user on the shared light client, I wait on a pre-sync the light client dies under and the worker closes once', async () => {
    // Given a tab waiting on a pre-sync still under way
    const presync = deferred<undefined>();
    const light = fakeLightClient({ presync: () => presync.promise });
    const worker = await bootWorker(light);
    const status = worker.connect().status;

    // When the light client cannot connect a chain, and pre-sync then fails for it
    light.fatal(FATAL);
    presync.reject(new Error('chainHead follow stopped'));
    await worker.closedOnce;

    // Then the tab heard only the fatal, and the worker closed once
    await expect(status.ended).resolves.toMatchObject(fatalEnd);
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('As a tab that connects after the light client died, I hear the fatal on subscribe', async () => {
    // Given a worker whose light client died before the tab that started it connected
    const flushed = deferred<undefined>();
    const light = fakeLightClient({ presync: () => deferred<undefined>().promise });
    const worker = await bootWorker(light, undefined, () => {
      flushed.resolve(undefined);
      return Promise.resolve();
    });
    light.fatal(FATAL);
    await afterQueuedTimers();
    expect(worker.close).not.toHaveBeenCalled();

    // When that tab's port connects, and its iframe speaks only after the worker flushed what it had to send
    const attached = worker.attach();
    await flushed.promise;
    await afterQueuedTimers();
    const tab = attached.speak();

    // Then it hears the fatal on subscribe, never ready, and the worker closes once after telling it
    await expect(tab.status.ended).resolves.toMatchObject(fatalEnd);
    expect(tab.status.events).toEqual([]);
    await worker.closedOnce;
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('As a tab that joins a dead worker through the relay, my ready wait fails with what the worker reported', async () => {
    // Given a worker whose light client died before this tab linked, and whose telemetry flush has run
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const light = fakeLightClient();
    const worker = await bootWorker(light);
    light.fatal(FATAL);
    const attached = worker.attach();
    await afterQueuedTimers();

    // When the tab's iframe links, its relay sharing the link's status subscription as the iframe's does
    const frame = linkHost();
    const linked = attached.link((transport, status) => {
      registerWorkerRelay(frame.serving, transport, status, createFrameStatus());
    });

    // Then the ready wait fails with the fatal, measured as the worker's report
    await expect(linked).rejects.toMatchObject(fatalEnd);
    expect(
      metrics.distributions
        .filter(metric => metric.name === `dotli.${S.PROTOCOL_SW_READY}`)
        .map(metric => metric.attributes),
    ).toEqual([{ outcome: 'error', reason: 'worker_reported' }]);
  });

  it('As every open tab, I hear the fatal, each in my own buffer', async () => {
    // Given three tabs on a synced worker
    const light = fakeLightClient();
    const worker = await bootWorker(light);
    const open = [worker.connect(), worker.connect(), worker.connect()];
    const statuses = await Promise.all(open.map(readyStatus));

    // When the light client dies
    light.fatal(FATAL);

    // Then each tab decoded the fatal from what the worker posted it
    await Promise.all(statuses.map(status => expect(status.ended).resolves.toMatchObject(fatalEnd)));
    // And no buffer was posted twice, to one tab or across them
    const posted = open.flatMap(tab => tab.posted);
    expect(new Set(posted).size).toBe(posted.length);
    for (const tab of open) {
      expect(tab.posted.length).toBeGreaterThan(0);
    }
  });

  it('As a dotli user whose pre-sync fails before my tab connected, I hear why at once and the worker then closes', async () => {
    // Given a worker whose pre-sync failed before the tab that started it connected
    const presync = deferred<undefined>();
    const worker = await bootWorker(fakeLightClient({ presync: () => presync.promise }));
    await endPresync(presync, new Error('chainHead follow stopped'));

    // When that tab connects, and the worker closes
    const status = worker.connect().status;
    await worker.closedOnce;

    // Then it heard why pre-sync failed, and the worker closed once
    await expect(status.ended).resolves.toMatchObject({ message: 'chainHead follow stopped' });
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user on the shared light client, I connect to a worker named for an unknown network and it stays up to tell me why', async () => {
    // Given a worker the iframe named for a network this build does not know
    const worker = await bootWorker(fakeLightClient(), 'dotli-protocol-nowhere');

    // When a tab connects
    const status = worker.connect().status;

    // Then it hears the cause, and the worker does not close, since a fresh one would fail the same way
    await expect(status.ended).resolves.toMatchObject({
      name: 'ProtocolInitFailedError',
      message: 'Unknown protocol network: "nowhere"',
    });
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
    const status = await readyStatus(worker.connect());

    // Then it is served, and the network this context reads is still its default
    expect(status.events).toEqual([undefined]);
    expect(getNetwork()).toBe('paseo-next-v2');
  });

  it('As a dotli user on the shared light client, I hear the stored database of each chain as the light client reads it', async () => {
    // Given a tab hearing telemetry while pre-sync is still under way
    const presync = deferred<undefined>();
    const light = fakeLightClient({ presync: () => presync.promise });
    const worker = await bootWorker(light);
    const tab = worker.connect();
    const telemetry = record(tab.transport, 'telemetry', undefined);
    await tab.transport.request('heartbeat', undefined);

    // When the light client reads the relay's database
    light.readDb('relay', 'miss');

    // Then the tab hears it
    await telemetry.until(1);
    expect(telemetry.events).toEqual([{ tag: 'smoldotDb', value: { chain: 'relay', outcome: 'miss' } }]);
  });

  it('As a dotli user on the shared light client, I join while it syncs and hear what it read of each database so far', async () => {
    // Given a worker still syncing that already read the relay's database
    const presync = deferred<undefined>();
    const light = fakeLightClient({ presync: () => presync.promise });
    const worker = await bootWorker(light);
    light.readDb('relay', 'unavailable');

    // When a tab connects and hears telemetry
    const telemetry = record(worker.connect().transport, 'telemetry', undefined);
    await telemetry.until(1);

    // Then it hears the read as it was, since it waits on the same sync
    expect(telemetry.events).toEqual([{ tag: 'smoldotDb', value: { chain: 'relay', outcome: 'unavailable' } }]);
  });

  it('As a dotli user on the shared light client, I join a synced worker and hear every database it read as a hit', async () => {
    // Given a synced worker that found no stored relay
    const light = fakeLightClient();
    const worker = await bootWorker(light);
    light.readDb('relay', 'miss');

    // When a tab connects and hears telemetry
    const telemetry = record(worker.connect().transport, 'telemetry', undefined);
    await telemetry.until(1);

    // Then this tab paid no sync cost
    expect(telemetry.events).toEqual([{ tag: 'smoldotDb', value: { chain: 'relay', outcome: 'hit' } }]);
  });

  it('As a dotli user on the shared light client, a light client that dies while Asset Hub syncs never tells a waiting tab it is ready', async () => {
    // Given a tab waiting on a pre-sync still under way
    const presync = deferred<undefined>();
    const light = fakeLightClient({ presync: () => presync.promise });
    const worker = await bootWorker(light);
    const waiting = worker.connect().status;

    // When the light client cannot connect a chain, and then Asset Hub syncs anyway
    light.fatal(FATAL);
    await endPresync(presync);
    const later = worker.connect().status;

    // Then both tabs heard only the fatal, and the engine never became ready
    await expect(waiting.ended).resolves.toMatchObject(fatalEnd);
    await expect(later.ended).resolves.toMatchObject(fatalEnd);
    expect([...waiting.events, ...later.events]).toEqual([]);
    expect(light.peopleWarms).toBe(0);
  });

  it("As a dotli user on the shared light client, my tab's loading screen hears how the shared chains sync", async () => {
    // Given a tab hearing telemetry while pre-sync is under way
    const light = fakeLightClient({ presync: () => new Promise<void>(() => undefined) });
    const worker = await bootWorker(light);
    const tab = worker.connect();
    const telemetry = record(tab.transport, 'telemetry', undefined);
    await tab.transport.request('heartbeat', undefined);

    // When the relay reports its warp progress
    for (const listener of light.syncListeners) {
      listener({ chain: 'relay', kind: 'warpSyncProgress', at: 10, target: 100 });
    }

    // Then the tab hears it as direct mode sends it
    await telemetry.until(1);
    expect(telemetry.events).toEqual([
      { tag: 'chainSync', value: { chain: 'relay', kind: 'warpSyncProgress', at: 10, target: 100 } },
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

    // When another tab connects and hears telemetry
    const telemetry = record(worker.connect().transport, 'telemetry', undefined);
    await telemetry.until(2);

    // Then it hears the chain is up, and pays no sync cost for it
    expect(telemetry.events).toEqual([
      { tag: 'chainSync', value: { chain: 'assethub', kind: 'bootstrapComplete' } },
      { tag: 'chainDetail', value: { chain: 'assethub', dbCache: 'hit' } },
    ]);
  });

  it('As a dotli user on the shared light client, a closed tab stops hearing chain sync', async () => {
    // Given two tabs hearing telemetry on a synced worker
    const light = fakeLightClient();
    const worker = await bootWorker(light);
    const leaving = worker.connect();
    const staying = worker.connect();
    record(leaving.transport, 'telemetry', undefined);
    record(staying.transport, 'telemetry', undefined);
    await Promise.all([leaving, staying].map(tab => tab.transport.request('heartbeat', undefined)));
    expect(light.syncListeners.size).toBe(2);

    // When the first tab leaves
    leaving.transport.dispose(new Error('pagehide'));

    // Then only the tab that stayed still hears chain sync
    await light.untilSyncListeners(1);
    expect(light.syncListeners.size).toBe(1);
  });

  it('As a dotli maintainer, a failed request tells the host where it was thrown', async () => {
    // Given a tab on a worker whose name resolution fails
    const failure = new Error('storage read failed');
    const worker = await bootWorker(fakeLightClient({ resolveDotName: () => Promise.reject(failure) }));
    const tab = worker.connect();

    // When the tab asks to resolve a name
    const resolution = record(tab.transport, 'resolveDotName', { label: 'doom' });

    // Then the end carries the failure's name and stack
    await expect(resolution.ended).resolves.toMatchObject({
      name: 'Error',
      message: 'storage read failed',
      remoteStack: failure.stack,
    });
  });

  it("As a dotli maintainer, the worker's span for a request carries the page load of the tab that sent it", async () => {
    // Given two tabs on a synced worker, one with a malformed resolution id
    const worker = await bootWorker(fakeLightClient());
    const first = worker.connect('load-1');
    const second = worker.connect('not a resolution id!');

    // When each sends a request, and the first a chain message and a heartbeat
    await record(first.transport, 'resolveDotName', { label: 'doom' }).ended;
    await second.transport.request('warmup', undefined);
    await connectChain(first, 'c1');
    await first.transport.request('chainSend', { connectionId: 'c1', message: '{"jsonrpc":"2.0"}' });
    await first.transport.request('heartbeat', undefined);

    // Then only a well-formed id is recorded, only on that request's span, and a chain message or heartbeat has none
    expect(worker.open.mock.calls).toEqual([
      ['protocol.worker_request', { root: true, attributes: { method: 'resolveDotName', resolution_id: 'load-1' } }],
      ['protocol.worker_request', { root: true, attributes: { method: 'warmup' } }],
      ['protocol.worker_request', { root: true, attributes: { method: 'chainConnect', resolution_id: 'load-1' } }],
    ]);
  });

  it('As a tab that left, my connections are freed at once', async () => {
    // Given two tabs that each hold a chain connection
    const light = fakeLightClient();
    const worker = await bootWorker(light);
    const leaving = worker.connect();
    const staying = worker.connect();
    await Promise.all([connectChain(leaving, 'c1'), connectChain(staying, 'c1')]);

    // When the first tab disposes its transport, as its page hides for good
    leaving.transport.dispose(new Error('pagehide'));

    // Then its connection is released before any heartbeat, and the shared chain stays up for the other tab
    await worker.untilLog('Chain disconnected: c1 (1 remaining)');
    expect(worker.beating()).toBe(true);
    for (const disconnect of light.disconnects) {
      expect(disconnect).not.toHaveBeenCalled();
    }
    // And the other tab's connection still carries its messages
    await expect(
      staying.transport.request('chainSend', { connectionId: 'c1', message: '{"jsonrpc":"2.0"}' }),
    ).resolves.toBeUndefined();
  });

  it('As a frozen tab, I hear my port was released when I thaw', async () => {
    // Given a tab holding a chain connection on a synced worker
    const worker = await bootWorker(fakeLightClient());
    const tab = worker.connect();
    const status = await readyStatus(tab);
    const chain = await connectChain(tab, 'c1');

    // When it is frozen, so it sends nothing for longer than the heartbeat allows
    outlastHeartbeat(worker);

    // Then the worker freed its connection at the release
    expect(worker.logs.map(line => line.message)).toContain('Chain disconnected: c1 (0 remaining)');
    // And once it thaws, its queued messages end its status and its chain with the release, not a halt
    await expect(status.ended).resolves.toMatchObject({ name: 'ProtocolPortReleasedError' });
    await expect(chain.ended).resolves.toMatchObject({ name: 'ProtocolPortReleasedError' });
  });

  it('As a frozen tab, my released port stays open so I hear the release whenever I thaw', async () => {
    // Given a tab on a synced worker
    const worker = await bootWorker(fakeLightClient());
    const tab = worker.connect();
    const status = await readyStatus(tab);

    // When it sends nothing for longer than the heartbeat allows
    outlastHeartbeat(worker);

    // Then the worker let it go without closing its port
    await expect(status.ended).resolves.toMatchObject({ name: 'ProtocolPortReleasedError' });
    expect(tab.closes()).toBe(0);
  });

  it('As a thawed tab that speaks on a released port, the worker closes that port', async () => {
    // Given a tab whose port the worker released
    const worker = await bootWorker(fakeLightClient());
    const attached = worker.attach();
    const tab = attached.speak();
    const status = await readyStatus(tab);
    outlastHeartbeat(worker);
    await status.ended;

    // When the thawed tab sends a message the worker no longer serves
    const received = attached.nextReceived();
    tab.transport.request('heartbeat', undefined).catch(() => undefined);
    await received;

    // Then the worker closed the port, once
    expect(tab.closes()).toBe(1);
  });

  it('As a closing dead worker, I close the ports I released before', async () => {
    // Given a tab whose port the worker released, and a tab still served
    const light = fakeLightClient();
    const worker = await bootWorker(light);
    const frozen = worker.connect();
    const frozenStatus = await readyStatus(frozen);
    outlastHeartbeat(worker);
    await frozenStatus.ended;
    const live = worker.connect();
    await readyStatus(live);

    // When the light client dies and the worker closes
    light.fatal(FATAL);
    await worker.closedOnce;

    // Then the released port is closed too
    expect(frozen.closes()).toBe(1);
  });

  it("As a long-hidden tab, I keep my port by answering the worker's beats", async () => {
    // Given a tab linked through the iframe's real link, whose timers never run, holding a chain connection
    const worker = await bootWorker(fakeLightClient());
    const attached = worker.attach();
    const transport = await attached.link();
    const chain = record(transport, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' });
    await chain.until(1);

    // When the worker beats many times, and the tab answers each beat as it arrives
    for (let i = 0; i < 3 * HEARTBEAT_MISSED_BEATS; i++) {
      const answered = attached.nextReceived();
      worker.beat();
      await answered;
    }

    // Then its port was never released, and its connection still carries its messages
    expect(worker.logs.map(line => line.message)).not.toContain('Port released');
    await expect(
      transport.request('chainSend', { connectionId: 'c1', message: '{"jsonrpc":"2.0"}' }),
    ).resolves.toBeUndefined();
  });

  it('As a frozen tab, I am released after the missed beats', async () => {
    // Given a tab that hears the worker's beats but, frozen, answers none of them
    const worker = await bootWorker(fakeLightClient());
    const tab = worker.connect();
    const beats = record(tab.transport, 'beat', undefined);
    await tab.transport.request('heartbeat', undefined);

    // When the worker beats as many times as it allows
    for (let i = 0; i < HEARTBEAT_MISSED_BEATS; i++) {
      worker.beat();
    }
    await beats.until(HEARTBEAT_MISSED_BEATS);

    // Then it still holds the port, and lets it go on the next beat
    expect(worker.logs.map(line => line.message)).not.toContain('Port released');
    worker.beat();
    await expect(beats.ended).resolves.toMatchObject({ name: 'ProtocolPortReleasedError' });
    expect(worker.logs.map(line => line.message)).toContain('Port released');
  });

  it('As a dotli user on the shared light client, a busy tab that sends no heartbeat but talks keeps its port', async () => {
    // Given a tab holding a chain connection
    const worker = await bootWorker(fakeLightClient());
    const tab = worker.connect();
    await connectChain(tab, 'c1');

    // When it sends a request every beat but no heartbeat
    for (let i = 0; i < 3 * HEARTBEAT_MISSED_BEATS; i++) {
      await tab.transport.request('warmup', undefined);
      worker.beat();
    }

    // Then its connection was never released, and a later request is served
    await expect(
      tab.transport.request('chainSend', { connectionId: 'c1', message: '{"jsonrpc":"2.0"}' }),
    ).resolves.toBeUndefined();
    expect(worker.logs.map(line => line.message)).not.toContain('Chain disconnected: c1 (0 remaining)');
  });

  it('As a dotli user on the shared light client, a worker whose light client died stops its heartbeat', async () => {
    // Given a tab on a synced worker
    const light = fakeLightClient();
    const worker = await bootWorker(light);
    worker.connect();

    // When the light client dies and the worker closes
    light.fatal(FATAL);
    await worker.closedOnce;

    // Then no beat runs after the close
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(worker.beating()).toBe(false);
  });

  it('As a dotli user on the shared light client, my tab hears the light client byte total for its speed readout', async () => {
    // Given a tab hearing telemetry on a worker whose light client has received bytes
    let total = 1_000;
    const worker = await bootWorker(fakeLightClient(), undefined, undefined, () => total);
    const telemetry = record(worker.connect().transport, 'telemetry', undefined);
    await telemetry.until(1);

    // When the next report interval passes
    total = 4_000;
    worker.tickNetBytes();

    // Then the tab hears the baseline, then the cumulative total
    await telemetry.until(2);
    expect(telemetry.events).toEqual([
      { tag: 'netBytes', value: 1_000 },
      { tag: 'netBytes', value: 4_000 },
    ]);
  });

  it("As a dotli user on the shared light client, I hear no byte reports after the worker's light client dies", async () => {
    // Given a tab on a worker that reports bytes, which heard the baseline
    const light = fakeLightClient();
    const worker = await bootWorker(light, undefined, undefined, () => 1_000);
    const telemetry = record(worker.connect().transport, 'telemetry', undefined);
    await telemetry.until(1);

    // When the light client dies, the worker closes, and an interval passes
    light.fatal(FATAL);
    await worker.closedOnce;
    worker.tickNetBytes();

    // Then the telemetry ended with the fatal, and no byte report reached the tab after the baseline
    await expect(telemetry.ended).resolves.toMatchObject(fatalEnd);
    expect(telemetry.events).toEqual([{ tag: 'netBytes', value: 1_000 }]);
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
      message: 'Unexpected SharedWorker name "dotli-protocol". The iframe did not encode the active network.',
    });
  });
});
