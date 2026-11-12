// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The light client and the resolver functions the worker is given are fakes, and the worker global is a fake scope.
// Each tab is a real transport on its own port pair, so the worker is driven over the wire as an iframe drives it.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { catchError, createManualTimers } from '@dotli/shared/testing';
import type { JsonRpcConnection } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig, getNetwork } from '@dotli/config';
import { bindCaptureSink, spans as S, type m } from '@dotli/metrics';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';
import {
  protocolSchema,
  type FrameFailure,
  type ProtocolTransport,
  type RemoteFailure,
  createFrameStatus,
} from '@dotli/protocol';
import { createPortProvider, createTransport, domain, err, hostFailure, ok, type MethodTypes } from '@dotli/transport';
import type { LightClient, LightClientChange, SmoldotDbChain, SmoldotDbOutcome } from '@dotli/chains';
import { createDeferred, bindLogSink, type LogLevel } from '@dotli/shared';
import { createTestTicker } from './createIntervalTicker.fake.js';
import { createWaitList } from './testing/createWaitList.js';
import {
  createWorkerLifecycle,
  HEARTBEAT_MISSED_BEATS,
  type WorkerLifecycle,
  type WorkerPort,
} from './createWorkerLifecycle.js';
import { startProtocolWorker, type WorkerResolver, type WorkerScope } from './startProtocolWorker.js';
import { connectSharedWorker } from './connectSharedWorker.js';
import type { EngineScope } from './createEngine.js';
import { PROTOCOL_APP_ERRORS } from './errors.js';
import { parseWorkerNetwork } from './parseWorkerNetwork.js';
import { registerWorkerRelay } from './registerWorkerRelay.js';
import { startLightClientService } from './startLightClientService.js';
import { closeHostLinks, linkHost } from './testing/linkHost.js';
import { record, type Recording } from './testing/record.js';

type StatusRecording = Recording<MethodTypes<typeof frame.status>['receive'], FrameFailure>;
type ChainRecording = Recording<MethodTypes<typeof chain.connect>['receive'], RemoteFailure>;

type ChainSyncEvent = Parameters<Parameters<WorkerResolver['onChainSync']>[0]>[0];
type ChainDetail = Parameters<Parameters<WorkerResolver['onChainDetail']>[0]>[0];
type SpanOpen = typeof m.open;

type LogLine = {
  level: LogLevel;
  message: string;
};

/** The light client and resolver the worker drives, with the levers a test pulls. */
type FakeLightClient = ReturnType<typeof createFakeLightClient>;

/** A worker started on a fake scope, with the levers a test pulls. */
type Worker = Awaited<ReturnType<typeof bootWorker>>;

/** A tab's port that reached the worker, before its iframe speaks. */
type Attached = ReturnType<Worker['attach']>;

/** A tab's protocol iframe, linked to the worker over its own port. */
type Tab = ReturnType<Attached['speak']>;

type Presync = ReturnType<typeof createDeferred<undefined>>;

/** The worker's ports and close, on their own. */

type CreateFakeLightClientParams = {
  /** What the resolver's Asset Hub pre-sync waits on. Settled at once when unset. */
  presync?: () => Promise<void>;
  /** How the resolver reads a name. Resolves to no name when unset. */
  resolveDotName?: () => Promise<string | null>;
  /** Replayed to each new chain sync listener, as the resolver does. */
  sync?: ChainSyncEvent[];
  /** Replayed to each new chain detail listener, as the resolver does. */
  detail?: ChainDetail[];
};

type BootWorkerParams = {
  /** The worker's name, which carries its network. */
  name?: string;
  /** Sends the worker's buffered telemetry. Resolves at once by default. */
  flush?: () => Promise<void>;
  /** The byte total the worker meters. Unset, it meters none. */
  readNetBytes?: () => number;
  /** Starts the worker's chains and name resolver. The real one by default. */
  startService?: typeof startLightClientService;
};

type AttachParams = {
  /** Whether the port fires `close`. It does by default. */
  closeEvent?: boolean;
};

type SpyOnPortParams = {
  /** The worker's end of the channel. */
  port: MessagePort;
  /** Gets each buffer the worker posts, before the transfer detaches it. */
  posted: ArrayBuffer[];
  /** Runs after the worker handled each message the tab sent. */
  onReceived: () => void;
  /** Runs when the worker closes the port. */
  onClosed: () => void;
  /** Each listener the worker has on the port, which the spy adds and removes as the worker does. */
  listeners: Set<unknown>;
  /** Whether the port fires `close`. */
  closeEvent: boolean;
};

const { frame, chain, resolve: names } = protocolSchema.sections;

const captures = { exception: vi.fn(), expected: vi.fn() };

const openPorts = new Set<MessagePort>();
const tabs = new Set<ProtocolTransport>();

const FATAL = 'chain 0xaa connection failed: wasm trap';

/** How a tab hears the light client died. */
const FATAL_END = err(domain({ tag: 'fatal', value: FATAL }));

/** How a tab hears the worker let go of its port: its status ends typed, and nothing else open hears from the worker. */
const RELEASED_STATUS = err(domain({ tag: 'released', value: PROTOCOL_APP_ERRORS.PORT_RELEASED }));

afterEach(() => {
  const over = new Error('The spec is over');
  for (const transport of tabs) {
    transport.dispose(over);
  }
  tabs.clear();
  for (const port of openPorts) {
    port.close();
  }
  openPorts.clear();
  // Last, since it throws on an issue no spec took, and the ports above must close either way.
  closeHostLinks();
});

/** A light client and resolver that record what the worker opened and asked, and replay what they hold. */
function createFakeLightClient({ presync, resolveDotName, sync = [], detail = [] }: CreateFakeLightClientParams = {}) {
  const listeners = new Set<(change: LightClientChange) => void>();
  const db = new Map<SmoldotDbChain, SmoldotDbOutcome>();
  const syncWaits = createWaitList();
  const syncListeners = new Set<(event: ChainSyncEvent) => void>();
  const disconnects: Mock<() => void>[] = [];
  const chains: string[] = [];
  const opened: string[] = [];
  const syncReporting: { chains: readonly string[]; openBefore: number }[] = [];
  let fatal: string | null = null;
  let peopleWarms = 0;
  let disconnectFailure: Error | null = null;
  const defaultPresync = Promise.resolve();
  const lightClient: LightClient = {
    createChainTransport(genesisHash) {
      chains.push(genesisHash);
      const disconnect = vi.fn<() => void>(() => {
        const failure = disconnectFailure;
        disconnectFailure = null;
        if (failure !== null) {
          throw failure;
        }
      });
      disconnects.push(disconnect);
      return {
        provider: (): JsonRpcConnection => {
          opened.push(genesisHash);
          return { send: () => undefined, disconnect };
        },
        followLimit: Infinity,
      };
    },
    isChainSupported: () => true,
    status: () => ({ fatal, db: new Map(db) }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const resolver: WorkerResolver = {
    enableSyncReporting: reported => {
      syncReporting.push({ chains: reported, openBefore: chains.length });
    },
    onChainSync(listener) {
      for (const event of sync) {
        listener(event);
      }
      syncListeners.add(listener);
      return stopHearingSync;

      function stopHearingSync(): void {
        syncListeners.delete(listener);
        syncWaits.check();
      }
    },
    onChainDetail(listener) {
      for (const chainDetail of detail) {
        listener(chainDetail);
      }
      return () => undefined;
    },
    createDotnsResolver() {
      return {
        resolveDotName: resolveDotName ?? (() => Promise.resolve(null)),
        resolveExecutableManifest: () => Promise.reject(new Error('no manifests in this test')),
        resolveOwner: () => Promise.resolve(null),
        resolveRootManifest: () => Promise.reject(new Error('no manifests in this test')),
        waitForAssetHubFinalized: presync ?? (() => defaultPresync),
        // Never settles, as People warms in the background.
        waitForPeopleFinalized() {
          peopleWarms += 1;
          return new Promise<void>(() => undefined);
        },
      };
    },
  };
  return {
    /** The light client the worker runs on. */
    lightClient,
    /** The resolver functions the worker is given. */
    resolver,
    /** The light client dies. */
    die(message: string): void {
      fatal = message;
      tellListeners({ kind: 'fatal', message });
    },
    /** The light client reads a chain's stored database. */
    readDb(chain: SmoldotDbChain, outcome: SmoldotDbOutcome): void {
      db.set(chain, outcome);
      tellListeners({ kind: 'db', chain, outcome });
    },
    /** Each listener that hears chain sync now. */
    syncListeners,
    /** Settles once no more than `count` listeners hear chain sync. Never rejects. */
    waitForSyncListeners: (count: number): Promise<void> => syncWaits.waitFor(() => syncListeners.size <= count),
    /** The disconnect of each chain the worker opened, in order. */
    disconnects,
    /** The genesis hash of each chain the worker opened, in order. */
    chains,
    /** The genesis hash of each connection the worker opened, in order, a resume's included. */
    opened,
    /** Each sync reporting call, with how many chains were already open when it came. */
    syncReporting,
    /** The pre-sync the worker awaited, or an already settled promise where the test holds it. */
    presyncDone: presync === undefined ? defaultPresync : Promise.resolve(),
    /** How many times the worker started warming People. Never throws. */
    countPeopleWarms: (): number => peopleWarms,
    /** How many listeners hear the light client change. Never throws. */
    countListeners: (): number => listeners.size,
    /** The next chain disconnect throws `failure`, once. */
    failNextDisconnect(failure: Error): void {
      disconnectFailure = failure;
    },
  };

  function tellListeners(change: LightClientChange): void {
    for (const listener of [...listeners]) {
      listener(change);
    }
  }
}

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

/**
 * The worker's end of a port, spying on each buffer it posts before the transfer detaches it, and calling `onReceived`
 * after the worker handled each message the tab sent. Without `closeEvent` it never fires `close`.
 */
function spyOnPort({ port, posted, onReceived, onClosed, listeners, closeEvent }: SpyOnPortParams): WorkerPort {
  type Listener = (event: { readonly data: unknown }) => void;
  const wrapped = new Map<Listener, (event: Event) => void>();
  return {
    postMessage(data, transfer) {
      posted.push(data);
      port.postMessage(data, transfer);
    },
    addEventListener: listen,
    removeEventListener: unlisten,
    start: () => {
      port.start();
    },
    close() {
      onClosed();
      port.close();
    },
  };

  function listen(type: 'message' | 'close', listener: Listener): void {
    if (type === 'close' && !closeEvent) {
      return;
    }
    wrapped.set(listener, forwardEvent);
    listeners.add(listener);
    port.addEventListener(type, forwardEvent);

    function forwardEvent(event: Event): void {
      listener({ data: 'data' in event ? event.data : undefined });
      onReceived();
    }
  }

  function unlisten(type: 'message' | 'close', listener: Listener): void {
    const wrapper = wrapped.get(listener);
    if (wrapper !== undefined) {
      port.removeEventListener(type, wrapper);
    }
    listeners.delete(listener);
  }
}

/**
 * Starts a worker on a fake scope, as the browser does when the first tab names it. Settles once the worker has acted
 * on a pre-sync that is already done, as it awaited that promise first.
 */
async function bootWorker(
  light: FakeLightClient,
  {
    name = 'dotli-protocol-paseo-next-v2',
    flush = () => Promise.resolve(),
    readNetBytes,
    startService = startLightClientService,
  }: BootWorkerParams = {},
) {
  const heartbeat = createTestTicker();
  const netBytesTicker = createTestTicker();
  const timers = createManualTimers();
  const logs: LogLine[] = [];
  const logWaits = createWaitList();
  onTestFinished(
    bindLogSink({
      emit({ level, message }) {
        logs.push({ level, message });
        logWaits.check();
      },
    }),
  );
  const connectListeners = new Set<(event: { readonly ports: readonly WorkerPort[] }) => void>();
  const closing = createDeferred<undefined>();
  const close = vi.fn<() => void>(() => {
    closing.resolve(undefined);
  });
  const scope: WorkerScope = {
    addEventListener: (_type, listener) => {
      connectListeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      connectListeners.delete(listener);
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
  const started = startProtocolWorker({
    scope,
    network: parseWorkerNetwork(name),
    lightClient: light.lightClient,
    resolver: light.resolver,
    openSpan: open,
    startHeartbeat: heartbeat.startTicker,
    flush,
    netBytes: readNetBytes === undefined ? undefined : { read: readNetBytes, startTicker: netBytesTicker.startTicker },
    timers,
    startService,
  });
  await light.presyncDone;
  return {
    /** A tab's iframe connects, telling the worker its page load. */
    connect: (resolutionId?: string) => attach().speak(resolutionId),
    /**
     * A tab's port reaches the worker, and its iframe speaks once the test says so. With `closeEvent` false the port
     * never tells the worker it closed, as on an engine without the event.
     */
    attach,
    /** One heartbeat interval passes, if the worker has not stopped its heartbeat. */
    beat: heartbeat.tick,
    /** Whether the worker's heartbeat runs. Never throws. */
    isBeating: (): boolean => heartbeat.countRunning() > 0,
    /** One byte-report interval passes for every running report. */
    tickNetBytes: netBytesTicker.tick,
    /** How many byte-report tickers run. Never throws. */
    countNetBytesTickers: netBytesTicker.countRunning,
    /** The worker global's close. */
    close,
    /** Settles once the worker closed. */
    closed: closing.promise,
    /**
     * Runs the worker's queued close and settles once the worker closed, after one more timer turn, so a second close
     * queued alongside the first has run too.
     */
    runQueuedClose,
    /** The worker's timers, which move only when a case advances them. */
    timers,
    /** Each line the worker logged, in order. */
    logs,
    /** Settles once the worker has logged `message`. Never rejects. */
    waitForLog: (message: string): Promise<void> => logWaits.waitFor(() => logs.some(line => line.message === message)),
    /** Opens the worker's spans. */
    open,
    /** How many listeners the worker has for tabs that connect. Never throws. */
    countConnectListeners: (): number => connectListeners.size,
    /** Disposes the worker, as `startProtocolWorker` returned it. */
    dispose: started.dispose,
  };

  function attach({ closeEvent = true }: AttachParams = {}) {
    const channel = new MessageChannel();
    openPorts.add(channel.port1);
    openPorts.add(channel.port2);
    const posted: ArrayBuffer[] = [];
    const listeners = new Set<unknown>();
    let closes = 0;
    let received = 0;
    const receivedWaits = createWaitList();
    for (const listener of [...connectListeners]) {
      listener({
        ports: [
          spyOnPort({
            port: channel.port1,
            posted,
            onReceived() {
              received += 1;
              receivedWaits.check();
            },
            onClosed: () => {
              closes += 1;
            },
            listeners,
            closeEvent,
          }),
        ],
      });
    }
    return {
      /** The iframe speaks through a bare transport, as the specs drive it. */
      speak(resolutionId?: string) {
        const transport = createTransport({
          schema: protocolSchema,
          provider: createPortProvider({ port: channel.port2 }),
          handshake: 'offer',
          hello: { resolutionId: resolutionId ?? null },
        });
        transport.connect();
        tabs.add(transport);
        return {
          /** The tab's end of the port. */
          transport,
          /** The worker's status as the tab hears it, subscribed on connect as an iframe does. */
          status: record({ transport, method: frame.status, start: undefined }),
          /** Every buffer the worker posted to this tab, as it was before the transfer detached it. */
          posted,
          /** How many times the worker closed its end of this tab's port. Never throws. */
          countCloses: (): number => closes,
          /** How many listeners the worker has on its end of this tab's port. Never throws. */
          countListeners: (): number => listeners.size,
          /** The tab's end of the port closes without its transport saying goodbye, as when the renderer crashes. */
          crash(): void {
            channel.port2.close();
          },
        };
      },
      /** The iframe speaks through its real link, whose timers never run, as in a page hidden for long. */
      link() {
        const linked = connectSharedWorker({
          worker: { port: channel.port2, addEventListener: () => undefined, removeEventListener: () => undefined },
          page: new EventTarget(),
          resolutionId: null,
          readyTimeoutMs: 30_000,
          timers: createManualTimers(),
        });
        tabs.add(linked.transport);
        return linked;
      },
      /** Settles once the worker handled the next message from this tab. Never rejects. */
      waitForReceived,
    };

    function waitForReceived(): Promise<void> {
      const seen = received;
      return receivedWaits.waitFor(() => received > seen);
    }
  }

  // The worker queues its close on a zero-delay timer, which fires only when the timers move. No message tells a case
  // whether a second close is queued behind it, so the timers move once more after the close.
  async function runQueuedClose(): Promise<void> {
    await timers.advance(0);
    await closing.promise;
    await timers.advance(0);
  }
}

/**
 * A worker lifecycle on its own, with a heartbeat and timers the test moves, a worker global that records its close,
 * and a record of each change in whether every tab asks for a pause.
 */
function startLifecycle() {
  const heartbeat = createTestTicker();
  const timers = createManualTimers();
  const close = vi.fn<() => void>();
  const everyTabPaused: boolean[] = [];
  const lifecycle = createWorkerLifecycle({
    scope: { close },
    status: createFrameStatus(),
    flush: () => Promise.resolve(),
    startHeartbeat: heartbeat.startTicker,
    timers,
    initialFailure: null,
    onEveryTabPausedChange: paused => {
      everyTabPaused.push(paused);
    },
  });
  return { lifecycle, heartbeat, timers, close, everyTabPaused };
}

/**
 * A session `lifecycle` admitted, on the worker's end of a fresh port pair, whose tab speaks and leaves only when the
 * test says so.
 */
function openSession(lifecycle: WorkerLifecycle) {
  const channel = new MessageChannel();
  openPorts.add(channel.port1);
  openPorts.add(channel.port2);
  const port = spyOnPort({
    port: channel.port1,
    posted: [],
    onReceived: () => undefined,
    onClosed: () => undefined,
    listeners: new Set(),
    closeEvent: true,
  });
  const transport = createTransport({
    schema: protocolSchema,
    provider: createPortProvider({ port, closeOnDispose: false }),
    handshake: 'respond',
    hello: { resolutionId: null },
  });
  tabs.add(transport);
  const session = { port, transport };
  lifecycle.admit(session);
  return {
    ...session,
    /** The tab sends something, which the worker hears at once. */
    speak(): void {
      channel.port1.dispatchEvent(new Event('message'));
    },
    /** The tab's end of the port closes, which the worker hears at once. */
    leave(): void {
      channel.port1.dispatchEvent(new Event('close'));
    },
  };
}

/** Lets the heartbeat run until a silent port is let go. */
function outlastHeartbeat(worker: Worker): void {
  for (let round = 0; round <= HEARTBEAT_MISSED_BEATS; round++) {
    worker.beat();
  }
}

/** Connects a chain on the tab and settles once the worker answered it is connected. */
async function connectChain(tab: Tab, connectionId: string): Promise<ChainRecording> {
  const connected = record({
    transport: tab.transport,
    method: chain.connect,
    start: { genesisHash: '0xaa', connectionId },
  });
  await connected.waitFor(1);
  return connected;
}

/** Settles with the tab's status once the worker said it is ready. */
async function waitForReady(tab: Tab): Promise<StatusRecording> {
  await tab.status.waitFor(1);
  return tab.status;
}

describe('protocol SharedWorker', () => {
  beforeEach(() => bindCaptureSink(captures));

  it('As a dotli user on the shared light client, I hear that the light client died and the worker then closes, so my reconnect starts a fresh one', async () => {
    // Given a tab on a synced worker
    const light = createFakeLightClient();
    const worker = await bootWorker(light);
    const status = await waitForReady(worker.connect());

    // When the light client cannot connect a chain, and the worker closes
    light.die(FATAL);
    await worker.runQueuedClose();

    // Then the tab heard the cause, and the worker closed once
    await expect(status.ended).resolves.toEqual(FATAL_END);
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('As a dead shared worker, I hold my close while my buffered telemetry flushes and close once it is sent', async () => {
    // Given a worker whose telemetry flush holds
    const light = createFakeLightClient();
    const flushing = createDeferred<undefined>();
    const worker = await bootWorker(light, { flush: () => flushing.promise });
    worker.connect();

    // When the light client dies and the timers queued behind the fatal have run
    light.die(FATAL);
    await worker.timers.advance(0);

    // Then the worker stays open while the flush holds
    expect(worker.close).not.toHaveBeenCalled();

    // When the flush is done, and the queued close runs
    flushing.resolve(undefined);
    await worker.runQueuedClose();

    // Then the worker closed once
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('As a dead shared worker, I see my flush give up, counted, and still close once', async () => {
    // Given a worker whose telemetry flush fails
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const light = createFakeLightClient();
    const worker = await bootWorker(light, { flush: () => Promise.reject(new Error('flush failed')) });
    worker.connect();

    // When the light client dies
    light.die(FATAL);
    await worker.runQueuedClose();

    // Then the worker closed once, and the failed flush was counted once
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(metrics.counted(S.TELEMETRY_FLUSH)).toEqual([{ outcome: 'error', reason: 'Error' }]);
  });

  it('As a dotli user on the shared light client, I hear why pre-sync failed and the worker then closes, so my reconnect starts a fresh one', async () => {
    // Given a tab waiting on a pre-sync still under way
    const presync = createDeferred<undefined>();
    const worker = await bootWorker(createFakeLightClient({ presync: () => presync.promise }));
    const status = worker.connect().status;

    // When pre-sync fails, and the worker closes
    presync.reject(new Error('chainHead follow stopped'));
    await worker.runQueuedClose();

    // Then the tab heard the cause as a failed init, and the worker closed once
    await expect(status.ended).resolves.toEqual(err(domain({ tag: 'initFailed', value: 'chainHead follow stopped' })));
    expect(status.events).toEqual([]);
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user on the shared light client, I wait on a pre-sync the light client dies under and the worker closes once', async () => {
    // Given a tab waiting on a pre-sync still under way
    const presync = createDeferred<undefined>();
    const light = createFakeLightClient({ presync: () => presync.promise });
    const worker = await bootWorker(light);
    const status = worker.connect().status;

    // When the light client cannot connect a chain, and pre-sync then fails for it
    light.die(FATAL);
    presync.reject(new Error('chainHead follow stopped'));
    await worker.runQueuedClose();

    // Then the tab heard only the fatal, and the worker closed once
    await expect(status.ended).resolves.toEqual(FATAL_END);
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('As a tab that connects after the light client died, I subscribe and hear the fatal before the worker closes', async () => {
    // Given a worker whose light client died before the tab that started it connected
    const flushed = createDeferred<undefined>();
    const light = createFakeLightClient({ presync: () => createDeferred<undefined>().promise });
    const worker = await bootWorker(light, {
      flush() {
        flushed.resolve(undefined);
        return Promise.resolve();
      },
    });
    light.die(FATAL);
    await worker.timers.advance(0);
    const closesBeforeConnect = worker.close.mock.calls.length;

    // When that tab's port connects, and its iframe speaks only after the worker flushed what it had to send
    const attached = worker.attach();
    await worker.timers.advance(0);
    await flushed.promise;
    await worker.timers.advance(0);
    const tab = attached.speak();

    // Then it hears the fatal on subscribe, never ready, from a worker that had not closed before it connected
    expect(closesBeforeConnect).toBe(0);
    await expect(tab.status.ended).resolves.toEqual(FATAL_END);
    expect(tab.status.events).toEqual([]);

    // When the worker's queued close runs
    await worker.runQueuedClose();

    // Then the worker closed once, after telling it
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('As a tab that joins a dead worker through the relay, I wait for ready and the wait fails with what the worker reported', async () => {
    // Given a worker whose light client died before this tab linked, and whose telemetry flush has run
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const light = createFakeLightClient();
    const worker = await bootWorker(light);
    light.die(FATAL);
    const attached = worker.attach();
    await worker.timers.advance(0);

    // When the tab's iframe links, its relay sharing the link's status subscription as the iframe's does
    const iframe = linkHost();
    const linked = attached.link();
    registerWorkerRelay({
      serving: iframe.serving,
      worker: linked.transport,
      workerStatus: linked.status,
      boot: {
        ...createFrameStatus(),
        serveTelemetry: () => undefined,
      },
    });

    // Then the ready wait fails with the fatal, measured as the worker's report
    await expect(linked.ready).rejects.toMatchObject({ name: 'ProtocolFatalError', message: FATAL });
    expect(
      metrics.distributions
        .filter(metric => metric.name === 'dotli.protocol.sw_ready')
        .map(metric => metric.attributes),
    ).toEqual([{ outcome: 'error', reason: 'worker_reported' }]);
  });

  it('As one of three open tabs, I hear the fatal and decode it from my own buffer, which no other tab shares', async () => {
    // Given three tabs on a synced worker
    const light = createFakeLightClient();
    const worker = await bootWorker(light);
    const open = [worker.connect(), worker.connect(), worker.connect()];
    const statuses = await Promise.all(open.map(waitForReady));

    // When the light client dies, and the worker's queued close runs
    light.die(FATAL);
    await worker.timers.advance(0);

    // Then each tab decoded the fatal from what the worker posted it
    await Promise.all(statuses.map(status => expect(status.ended).resolves.toEqual(FATAL_END)));
    // And no buffer was posted twice, to one tab or across them
    const posted = open.flatMap(tab => tab.posted);
    expect(new Set(posted).size).toBe(posted.length);
    for (const tab of open) {
      expect(tab.posted.length).toBeGreaterThan(0);
    }
  });

  it('As a dotli user whose pre-sync fails before my tab connected, I hear why at once and the worker then closes', async () => {
    // Given a worker whose pre-sync failed before the tab that started it connected
    const presync = createDeferred<undefined>();
    const worker = await bootWorker(createFakeLightClient({ presync: () => presync.promise }));
    await endPresync(presync, new Error('chainHead follow stopped'));

    // When that tab connects, and the worker closes
    const status = worker.connect().status;
    await worker.runQueuedClose();

    // Then it heard why pre-sync failed, and the worker closed once
    await expect(status.ended).resolves.toEqual(err(domain({ tag: 'initFailed', value: 'chainHead follow stopped' })));
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user whose worker fails to start its service, I hear why, my chain call is refused, the failure is counted and the worker then closes', async () => {
    // Given a worker whose service throws as it starts
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const worker = await bootWorker(createFakeLightClient(), {
      startService() {
        throw new Error('chain pool failed to open');
      },
    });

    // When a tab connects and sends a chain message, and the worker closes
    const tab = worker.connect();
    const sent = await tab.transport.request(chain.send, { connectionId: 'c1', message: '{"jsonrpc":"2.0"}' });
    await worker.runQueuedClose();

    // Then the tab heard why, its call was refused, the pre-sync failure was counted, and the worker closed once
    await expect(tab.status.ended).resolves.toEqual(
      err(domain({ tag: 'initFailed', value: 'chain pool failed to open' })),
    );
    expect(sent).toEqual(err(hostFailure(`Error: ${PROTOCOL_APP_ERRORS.CHAIN_BROKER_FAILED}`)));
    expect(metrics.counted(S.SMOLDOT_PRESYNC)).toEqual([{ outcome: 'error', reason: 'Error' }]);
    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user on the shared light client, I connect to a worker named for an unknown network and it stays up to tell me why', async () => {
    // Given a worker the iframe named for a network this build does not know
    const worker = await bootWorker(createFakeLightClient(), { name: 'dotli-protocol-nowhere' });

    // When a tab connects
    const status = worker.connect().status;

    // Then it hears the cause, and the worker does not close, since a fresh one would fail the same way
    await expect(status.ended).resolves.toEqual(
      err(domain({ tag: 'initFailed', value: 'Unknown protocol network: "nowhere"' })),
    );
    expect(worker.close).not.toHaveBeenCalled();
  });

  it('As the shared worker named for a network this build does not know, I open no chain and report no sync', async () => {
    // Given
    const light = createFakeLightClient();

    // When
    await bootWorker(light, { name: 'dotli-protocol-nowhere' });

    // Then
    expect(light.chains).toEqual([]);
    expect(light.syncReporting).toEqual([]);
  });

  it('As the shared worker, I serve the network my name carries and leave the config of this context to my entry', async () => {
    // Given a worker the iframe named for Previewnet
    const worker = await bootWorker(createFakeLightClient(), { name: 'dotli-protocol-previewnet' });

    // When a tab connects
    const status = await waitForReady(worker.connect());

    // Then it is served, and the network this context reads is still its default
    expect(status.events).toEqual([undefined]);
    expect(getNetwork()).toBe('paseo-next-v2');
  });

  it('As a dotli user on the shared light client, I subscribe to telemetry and hear the stored database of each chain as the light client reads it', async () => {
    // Given a tab hearing telemetry while pre-sync is still under way
    const presync = createDeferred<undefined>();
    const light = createFakeLightClient({ presync: () => presync.promise });
    const worker = await bootWorker(light);
    const tab = worker.connect();
    const telemetry = record({ transport: tab.transport, method: frame.telemetry, start: undefined });
    await tab.transport.request(frame.heartbeat, undefined);

    // When the light client reads the relay's database
    light.readDb('relay', 'miss');

    // Then the tab hears it
    await telemetry.waitFor(1);
    expect(telemetry.events).toEqual([{ tag: 'smoldotDb', value: { chain: 'relay', outcome: 'miss' } }]);
  });

  it('As a dotli user on the shared light client, I join while it syncs and hear what it read of each database so far', async () => {
    // Given a worker still syncing that already read the relay's database
    const presync = createDeferred<undefined>();
    const light = createFakeLightClient({ presync: () => presync.promise });
    const worker = await bootWorker(light);
    light.readDb('relay', 'unavailable');

    // When a tab connects and hears telemetry
    const telemetry = record({ transport: worker.connect().transport, method: frame.telemetry, start: undefined });
    await telemetry.waitFor(1);

    // Then it hears the read as it was, since it waits on the same sync
    expect(telemetry.events).toEqual([{ tag: 'smoldotDb', value: { chain: 'relay', outcome: 'unavailable' } }]);
  });

  it('As a dotli user on the shared light client, I join a synced worker and hear every database it read as a hit', async () => {
    // Given a synced worker that found no stored relay
    const light = createFakeLightClient();
    const worker = await bootWorker(light);
    light.readDb('relay', 'miss');

    // When a tab connects and hears telemetry
    const telemetry = record({ transport: worker.connect().transport, method: frame.telemetry, start: undefined });
    await telemetry.waitFor(1);

    // Then this tab paid no sync cost
    expect(telemetry.events).toEqual([{ tag: 'smoldotDb', value: { chain: 'relay', outcome: 'hit' } }]);
  });

  it('As a dotli user on the shared light client, I wait on a light client that dies while Asset Hub syncs and never hear that it is ready', async () => {
    // Given a tab waiting on a pre-sync still under way
    const presync = createDeferred<undefined>();
    const light = createFakeLightClient({ presync: () => presync.promise });
    const worker = await bootWorker(light);
    const waiting = worker.connect().status;

    // When the light client cannot connect a chain, Asset Hub syncs anyway, and the worker's queued close runs
    light.die(FATAL);
    await endPresync(presync);
    const later = worker.connect().status;
    await worker.timers.advance(0);

    // Then both tabs heard only the fatal, and the engine never became ready
    await expect(waiting.ended).resolves.toEqual(FATAL_END);
    await expect(later.ended).resolves.toEqual(FATAL_END);
    expect([...waiting.events, ...later.events]).toEqual([]);
    expect(light.countPeopleWarms()).toBe(0);
  });

  it('As a dotli user on the shared light client, I start the worker and the relay and Bulletin sync shows before any product asks for them', async () => {
    // Given
    const light = createFakeLightClient();
    const services = getActiveServicesConfig();

    // When
    await bootWorker(light);

    // Then sync reporting is on before the first chain opens, and the relay and Bulletin open with nothing asking
    expect(light.syncReporting).toEqual([{ chains: ['relay', 'assethub', 'bulletin', 'people'], openBefore: 0 }]);
    expect(light.chains).toEqual([services.relay.genesis, services.bulletin.genesis]);
  });

  it('As a dotli user on the shared light client, I join a synced worker and hear where the chains stand, and that it started warm', async () => {
    // Given a synced worker whose own first start found Asset Hub cold on disk
    const worker = await bootWorker(
      createFakeLightClient({
        sync: [{ chain: 'assethub', kind: 'bootstrapComplete' }],
        detail: [{ chain: 'assethub', dbCache: 'miss' }],
      }),
    );

    // When another tab connects and hears telemetry
    const telemetry = record({ transport: worker.connect().transport, method: frame.telemetry, start: undefined });
    await telemetry.waitFor(2);

    // Then it hears the chain is up, and pays no sync cost for it
    expect(telemetry.events).toEqual([
      { tag: 'chainSync', value: { chain: 'assethub', kind: 'bootstrapComplete' } },
      { tag: 'chainDetail', value: { chain: 'assethub', dbCache: 'hit' } },
    ]);
  });

  it('As a dotli user on the shared light client, I close one tab and it stops hearing chain sync', async () => {
    // Given two tabs hearing telemetry on a synced worker
    const light = createFakeLightClient();
    const worker = await bootWorker(light);
    const leaving = worker.connect();
    const staying = worker.connect();
    record({ transport: leaving.transport, method: frame.telemetry, start: undefined });
    record({ transport: staying.transport, method: frame.telemetry, start: undefined });
    await Promise.all([leaving, staying].map(tab => tab.transport.request(frame.heartbeat, undefined)));
    const listenersBefore = light.syncListeners.size;

    // When the first tab leaves
    leaving.transport.dispose(new Error('pagehide'));

    // Then only the tab that stayed still hears chain sync
    await light.waitForSyncListeners(1);
    expect(listenersBefore).toBe(2);
    expect(light.syncListeners.size).toBe(1);
  });

  it("As a dotli maintainer, I watch a name read fail and the host hears it under its error's name", async () => {
    // Given a tab on a worker whose name resolution fails
    const failure = new Error('storage read failed');
    const worker = await bootWorker(createFakeLightClient({ resolveDotName: () => Promise.reject(failure) }));
    const tab = worker.connect();

    // When the tab asks to resolve a name
    const resolution = record({ transport: tab.transport, method: names.dotName, start: { label: 'doom' } });

    // Then the end carries the failure's name and message
    await expect(resolution.ended).resolves.toEqual(err(hostFailure(failure)));
  });

  it('As a dotli maintainer, I watch the worker refuse a chain message and see it logged there as other failed requests are', async () => {
    // Given a tab on a synced worker
    const worker = await bootWorker(createFakeLightClient());
    const tab = worker.connect();
    await waitForReady(tab);

    // When the tab sends on a connection the worker does not hold
    const sent = tab.transport.request(chain.send, {
      connectionId: 'gone',
      message: '{"jsonrpc":"2.0"}',
    });

    // Then the tab hears the refusal, and the worker logged it
    await expect(sent).resolves.toEqual(err(hostFailure('Error: Unknown chain connection: gone')));
    expect(worker.logs).toContainEqual({
      level: 'warn',
      // The matcher is typed `any`, which the lint refuses in a typed literal.
      message: expect.stringContaining('[dot.li SW] chainSend failed') as string,
    });
  });

  it("As a dotli maintainer, I watch tabs send requests and the worker's span for each carries the page load of the tab that sent it", async () => {
    // Given two tabs on a synced worker, one with a malformed resolution id
    const worker = await bootWorker(createFakeLightClient());
    const first = worker.connect('load-1');
    const second = worker.connect('not a resolution id!');

    // When each sends a request, and the first a chain message and a heartbeat
    await record({ transport: first.transport, method: names.dotName, start: { label: 'doom' } }).ended;
    await second.transport.request(frame.warmup, undefined);
    await connectChain(first, 'c1');
    await first.transport.request(chain.send, {
      connectionId: 'c1',
      message: '{"jsonrpc":"2.0"}',
    });
    await first.transport.request(frame.heartbeat, undefined);

    // Then only a well-formed id is recorded, only on that request's span, and a chain message or heartbeat has none
    expect(worker.open.mock.calls).toEqual([
      ['protocol.worker_request', { root: true, attributes: { method: 'resolveDotName', resolution_id: 'load-1' } }],
      ['protocol.worker_request', { root: true, attributes: { method: 'warmup' } }],
      ['protocol.worker_request', { root: true, attributes: { method: 'chainConnect', resolution_id: 'load-1' } }],
    ]);
  });

  it('As a tab that left, I dispose my transport and my connections are freed once the worker misses my beats, since my dispose tells it nothing', async () => {
    // Given two tabs that each hold a chain connection, the leaving one on an engine whose ports never say they closed
    const light = createFakeLightClient();
    const worker = await bootWorker(light);
    const leaving = worker.attach({ closeEvent: false }).speak();
    const staying = worker.connect();
    await Promise.all([connectChain(leaving, 'c1'), connectChain(staying, 'c1')]);

    // When the first tab disposes its transport, as its page hides for good
    leaving.transport.dispose(new Error('pagehide'));
    await staying.transport.request(frame.heartbeat, undefined);

    // Then the worker still holds its connection, since a closing transport posts nothing
    expect(worker.logs.map(line => line.message)).not.toContain('Chain disconnected: c1 (1 remaining)');

    // When the heartbeat runs past the beats the worker allows, while the other tab answers each
    for (let round = 0; round <= HEARTBEAT_MISSED_BEATS; round++) {
      await staying.transport.request(frame.heartbeat, undefined);
      worker.beat();
    }

    // Then only the tab that left is released, its connection is freed, and the shared chain stays up for the other tab
    await worker.waitForLog('Chain disconnected: c1 (1 remaining)');
    expect(worker.logs.filter(line => line.message === 'Port released')).toHaveLength(1);
    expect(worker.isBeating()).toBe(true);
    for (const disconnect of light.disconnects) {
      expect(disconnect).not.toHaveBeenCalled();
    }

    // When the other tab sends on its connection
    const answer = staying.transport.request(chain.send, { connectionId: 'c1', message: '{"jsonrpc":"2.0"}' });

    // Then its connection still carries its messages
    await expect(answer).resolves.toEqual(ok());
  });

  it('As a frozen tab, I thaw and hear my port was released', async () => {
    // Given a tab holding a chain connection on a synced worker
    const worker = await bootWorker(createFakeLightClient());
    const tab = worker.connect();
    const status = await waitForReady(tab);
    const connected = await connectChain(tab, 'c1');

    // When it is frozen, so it sends nothing for longer than the heartbeat allows
    outlastHeartbeat(worker);

    // Then the worker freed its connection at the release
    expect(worker.logs.map(line => line.message)).toContain('Chain disconnected: c1 (0 remaining)');
    // And once it thaws, its queued messages end its status with the release, and its chain hears no halt, since the
    // tab's link ends the rest of what it holds with that end
    await expect(status.ended).resolves.toEqual(RELEASED_STATUS);
    expect(connected.events).toEqual([{ tag: 'connected', value: undefined }]);
  });

  it('As a thawed tab, I speak on a released port and the worker closes that port on its next beat', async () => {
    // Given a tab whose port the worker released
    const worker = await bootWorker(createFakeLightClient());
    const attached = worker.attach();
    const tab = attached.speak();
    const status = await waitForReady(tab);
    outlastHeartbeat(worker);
    await status.ended;

    // When the thawed tab sends a message the worker no longer serves
    const received = attached.waitForReceived();
    tab.transport.request(frame.heartbeat, undefined).catch(() => undefined);
    await received;

    // Then the port stays open, so the ends queued at the release still reach the tab
    expect(tab.countCloses()).toBe(0);

    // When the next beat comes, and another after it
    worker.beat();
    worker.beat();

    // Then the worker closed the port, once
    expect(tab.countCloses()).toBe(1);
  });

  it('As a tab that speaks while the worker releases it, I hear the release and only then does my port close', async () => {
    // Given a tab whose next message is on its way as the worker releases it
    const worker = await bootWorker(createFakeLightClient());
    const attached = worker.attach();
    const tab = attached.speak();
    const status = await waitForReady(tab);
    for (let round = 0; round < HEARTBEAT_MISSED_BEATS; round++) {
      worker.beat();
    }
    const received = attached.waitForReceived();
    tab.transport.request(frame.heartbeat, undefined).catch(() => undefined);

    // When the worker releases it before that message arrives
    worker.beat();
    await received;

    // Then the tab hears the release, and its port is still open
    await expect(status.ended).resolves.toEqual(RELEASED_STATUS);
    expect(tab.countCloses()).toBe(0);

    // When the next beat comes
    worker.beat();

    // Then the beat closed the port
    expect(tab.countCloses()).toBe(1);
  });

  it('As a tab that crashed, I close my port and the worker forgets it at once', async () => {
    // Given a ready tab holding a chain connection
    const worker = await bootWorker(createFakeLightClient());
    const tab = worker.connect();
    await waitForReady(tab);
    await connectChain(tab, 'c1');

    // When its end of the port closes with no unsubscribe sent
    tab.crash();
    await worker.waitForLog('Port closed');

    // Then its connection is freed and its port closed, with no beat
    expect(worker.logs.map(line => line.message)).toContain('Chain disconnected: c1 (0 remaining)');
    expect(tab.countCloses()).toBe(1);

    // When the heartbeat runs past the beats the worker allows
    outlastHeartbeat(worker);

    // Then there was no port left to release
    expect(worker.logs.map(line => line.message)).not.toContain('Port released');
  });

  it('As a released tab that crashed, I close my port and the worker closes its end at once, with no message from me', async () => {
    // Given a tab whose port the worker released
    const worker = await bootWorker(createFakeLightClient());
    const tab = worker.connect();
    const status = await waitForReady(tab);
    outlastHeartbeat(worker);
    await status.ended;
    const closed = worker.waitForLog('Released port closed');

    // When its end of the port closes
    tab.crash();
    await closed;

    // Then the worker closed its end before any beat
    expect(tab.countCloses()).toBe(1);

    // When the next beat comes
    worker.beat();

    // Then the port was closed only once
    expect(tab.countCloses()).toBe(1);
  });

  it('As a closing dead worker, I close and the ports I released before close too', async () => {
    // Given a tab whose port the worker released, and a tab still served
    const light = createFakeLightClient();
    const worker = await bootWorker(light);
    const frozen = worker.connect();
    const frozenStatus = await waitForReady(frozen);
    outlastHeartbeat(worker);
    await frozenStatus.ended;
    const live = worker.connect();
    await waitForReady(live);

    // When the light client dies and the worker closes
    light.die(FATAL);
    await worker.runQueuedClose();

    // Then the released port is closed too
    expect(frozen.countCloses()).toBe(1);
  });

  it("As a long-hidden tab, I answer the worker's beats and keep my port", async () => {
    // Given a tab linked through the iframe's real link, whose timers never run, holding a chain connection
    const worker = await bootWorker(createFakeLightClient());
    const attached = worker.attach();
    const linked = attached.link();
    await linked.ready;
    const { transport } = linked;
    const connected = record({
      transport,
      method: chain.connect,
      start: { genesisHash: '0xaa', connectionId: 'c1' },
    });
    await connected.waitFor(1);

    // When the worker beats many times, and the tab answers each beat as it arrives, then sends on its connection
    for (let round = 0; round < 3 * HEARTBEAT_MISSED_BEATS; round++) {
      const answered = attached.waitForReceived();
      worker.beat();
      await answered;
    }
    const answer = transport.request(chain.send, { connectionId: 'c1', message: '{"jsonrpc":"2.0"}' });

    // Then its port was never released, and its connection still carries its messages
    expect(worker.logs.map(line => line.message)).not.toContain('Port released');
    await expect(answer).resolves.toEqual(ok());
  });

  it('As a frozen tab, I miss the beats the worker allows and am released on the next', async () => {
    // Given a tab that hears the worker's beats but, frozen, answers none of them
    const worker = await bootWorker(createFakeLightClient());
    const tab = worker.connect();
    const beats = record({ transport: tab.transport, method: frame.beat, start: undefined });
    await tab.transport.request(frame.heartbeat, undefined);

    // When the worker beats as many times as it allows
    for (let round = 0; round < HEARTBEAT_MISSED_BEATS; round++) {
      worker.beat();
    }
    await beats.waitFor(HEARTBEAT_MISSED_BEATS);

    // Then it still holds the port
    expect(worker.logs.map(line => line.message)).not.toContain('Port released');

    // When the next beat comes
    worker.beat();

    // Then it lets the port go
    await expect(tab.status.ended).resolves.toEqual(RELEASED_STATUS);
    expect(worker.logs.map(line => line.message)).toContain('Port released');
  });

  it('As a dotli user on the shared light client, I keep a busy tab talking without heartbeats and it keeps its port', async () => {
    // Given a tab holding a chain connection
    const worker = await bootWorker(createFakeLightClient());
    const tab = worker.connect();
    await connectChain(tab, 'c1');

    // When it sends a request every beat but no heartbeat, then sends on its connection
    for (let round = 0; round < 3 * HEARTBEAT_MISSED_BEATS; round++) {
      await tab.transport.request(frame.warmup, undefined);
      worker.beat();
    }
    const answer = tab.transport.request(chain.send, { connectionId: 'c1', message: '{"jsonrpc":"2.0"}' });

    // Then its connection was never released, and the later request is served
    await expect(answer).resolves.toEqual(ok());
    expect(worker.logs.map(line => line.message)).not.toContain('Chain disconnected: c1 (0 remaining)');
  });

  it('As a dotli user on the shared light client, I watch the light client die and the worker stops its heartbeat', async () => {
    // Given a tab on a synced worker
    const light = createFakeLightClient();
    const worker = await bootWorker(light);
    worker.connect();

    // When the light client dies and the worker closes
    light.die(FATAL);
    await worker.runQueuedClose();

    // Then no beat runs after the close
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(worker.isBeating()).toBe(false);
  });

  it('As a dotli user with many tabs on the shared light client, I subscribe in every tab and each hears the byte total from one meter', async () => {
    // Given two tabs hearing telemetry on a worker that reports bytes
    let total = 1_000;
    const worker = await bootWorker(createFakeLightClient(), { readNetBytes: () => total });
    const first = worker.connect();
    const second = worker.connect();
    const heardFirst = record({ transport: first.transport, method: frame.telemetry, start: undefined });
    const heardSecond = record({ transport: second.transport, method: frame.telemetry, start: undefined });
    await Promise.all([heardFirst.waitFor(1), heardSecond.waitFor(1)]);

    // When the next report interval passes
    total = 4_000;
    worker.tickNetBytes();
    await Promise.all([heardFirst.waitFor(2), heardSecond.waitFor(2)]);

    // Then one ticker served both tabs, and each heard the baseline, then the cumulative total
    const heard = [
      { tag: 'netBytes', value: 1_000 },
      { tag: 'netBytes', value: 4_000 },
    ];
    expect(worker.countNetBytesTickers()).toBe(1);
    expect([heardFirst.events, heardSecond.events]).toEqual([heard, heard]);

    // When both tabs stop listening, with a round trip after
    heardFirst.unsubscribe();
    heardSecond.unsubscribe();
    await Promise.all([first, second].map(tab => tab.transport.request(frame.heartbeat, undefined)));

    // Then the ticker stopped
    expect(worker.countNetBytesTickers()).toBe(0);
  });

  it("As a dotli user on the shared light client, I watch the worker's light client die and hear no byte reports after", async () => {
    // Given a tab on a worker that reports bytes, which heard the baseline
    const light = createFakeLightClient();
    const worker = await bootWorker(light, { readNetBytes: () => 1_000 });
    const tab = worker.connect();
    const telemetry = record({ transport: tab.transport, method: frame.telemetry, start: undefined });
    await telemetry.waitFor(1);

    // When the light client dies, the worker closes, and an interval passes
    light.die(FATAL);
    await worker.runQueuedClose();
    worker.tickNetBytes();

    // Then the tab heard the fatal on its status, and no byte report reached it after the baseline
    await expect(tab.status.ended).resolves.toEqual(FATAL_END);
    expect(telemetry.events).toEqual([{ tag: 'netBytes', value: 1_000 }]);
  });

  it('As a worker that was disposed, I admit no tab that connects', async () => {
    // Given a worker that was disposed
    const worker = await bootWorker(createFakeLightClient());
    worker.dispose();

    // When a tab's port reaches it, and its iframe speaks
    const tab = worker.connect();

    // Then the worker hears no tab connect, and never served the port
    expect(worker.countConnectListeners()).toBe(0);
    expect(tab.countListeners()).toBe(0);
    expect(tab.posted).toEqual([]);
    expect(worker.logs.map(line => line.message)).not.toContain('Port connected');
  });

  it('As a worker disposed while a tab is connected, I let go of its port', async () => {
    // Given a ready tab on a synced worker
    const worker = await bootWorker(createFakeLightClient());
    const tab = worker.connect();
    await waitForReady(tab);

    // When the worker is disposed
    worker.dispose();

    // Then it closed its end of the port at once and stopped listening on it, and did not close itself
    expect(tab.countCloses()).toBe(1);
    expect(tab.countListeners()).toBe(0);
    expect(worker.close).not.toHaveBeenCalled();
  });

  it('As a worker disposed while it holds a released port, I close that port too', async () => {
    // Given a frozen tab whose port the worker released and still holds open
    const worker = await bootWorker(createFakeLightClient());
    const tab = worker.connect();
    const status = await waitForReady(tab);
    outlastHeartbeat(worker);
    await status.ended;

    // When the worker is disposed
    worker.dispose();

    // Then it closed the released port once and stopped listening on it
    expect(tab.countCloses()).toBe(1);
    expect(tab.countListeners()).toBe(0);
  });

  it('As a failed worker disposed before my close timer runs, I never close', async () => {
    // Given a ready tab on a worker whose light client died, with its close queued
    const light = createFakeLightClient();
    const worker = await bootWorker(light);
    await waitForReady(worker.connect());
    light.die(FATAL);

    // When the worker is disposed, and its timers then run
    worker.dispose();
    const pendingAfterDispose = worker.timers.countPending();
    await worker.timers.advance(0);

    // Then its queued close was cleared, and the worker never closed
    expect(pendingAfterDispose).toBe(0);
    expect(worker.close).not.toHaveBeenCalled();
  });

  it('As a failed and flushed worker whose tab has not heard its status, I never close after my dispose', async () => {
    // Given a tab whose port reached the worker but never subscribed to its status, on a worker that failed and flushed
    // its telemetry
    const light = createFakeLightClient();
    const worker = await bootWorker(light);
    worker.attach();
    light.die(FATAL);
    await worker.timers.advance(0);

    // When the worker is disposed, which lets go of that port
    worker.dispose();

    // Then the worker never closed
    expect(worker.close).not.toHaveBeenCalled();
  });

  it('As a failed worker disposed while my flush is pending, I never close once it settles', async () => {
    // Given a ready tab on a worker whose light client died, whose close timer ran and whose flush holds
    const light = createFakeLightClient();
    const flushing = createDeferred<undefined>();
    const worker = await bootWorker(light, { flush: () => flushing.promise });
    await waitForReady(worker.connect());
    light.die(FATAL);
    await worker.timers.advance(0);

    // When the worker is disposed, and the flush then settles
    worker.dispose();
    flushing.resolve(undefined);
    await flushing.promise;

    // Then the worker never closed
    expect(worker.close).not.toHaveBeenCalled();
  });

  it('As a worker disposed during its pre-sync, I report nothing more when it fails', async () => {
    // Given a tab that subscribed to its status on a worker whose pre-sync is under way
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const presync = createDeferred<undefined>();
    const worker = await bootWorker(createFakeLightClient({ presync: () => presync.promise }));
    const tab = worker.connect();
    await tab.transport.request(frame.heartbeat, undefined);

    // When the worker is disposed, its pre-sync then fails, and its timers run
    worker.dispose();
    await endPresync(presync, new Error('chainHead follow stopped'));
    await worker.timers.advance(0);

    // Then it counted no pre-sync, logged no failure and never closed
    expect(metrics.counted(S.SMOLDOT_PRESYNC)).toEqual([]);
    expect(worker.logs.filter(line => line.level === 'error')).toEqual([]);
    expect(worker.close).not.toHaveBeenCalled();
  });

  it('As a worker disposed during its pre-sync, I report nothing more when it completes', async () => {
    // Given a worker whose pre-sync is under way
    const presync = createDeferred<undefined>();
    const light = createFakeLightClient({ presync: () => presync.promise });
    const worker = await bootWorker(light);

    // When the worker is disposed, and its pre-sync then completes
    worker.dispose();
    await endPresync(presync);

    // Then it logged no completion and warmed no People
    expect(worker.logs.map(line => line.message)).not.toContain('Pre-sync complete');
    expect(light.countPeopleWarms()).toBe(0);
  });

  it('As a worker disposed after its pre-sync, I let go of the chains', async () => {
    // Given a synced worker, which opened the relay and Bulletin
    const light = createFakeLightClient();
    const worker = await bootWorker(light);

    // When the worker is disposed
    worker.dispose();

    // Then each chain it opened was disconnected once
    expect(light.disconnects.map(disconnect => disconnect.mock.calls.length)).toEqual([1, 1]);
  });

  it('As a worker whose chain disconnect throws, I am disposed without a throw, the failure is reported and my tab was freed', async () => {
    // Given a tab holding a chain connection on a synced worker, and a light client whose next chain disconnect throws
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const light = createFakeLightClient();
    const worker = await bootWorker(light);
    const tab = worker.connect();
    await connectChain(tab, 'c1');
    const failure = new Error('chain disconnect failed');
    light.failNextDisconnect(failure);

    // When the worker is disposed
    const thrown = catchError(worker.dispose);

    // Then nothing threw, the failed close was counted, and the tab's connection and port were freed
    expect(thrown).toBeUndefined();
    expect(metrics.counted('chain_pool.close')).toEqual([{ outcome: 'error', reason: 'Error' }]);
    expect(worker.logs.map(line => line.message)).toContain('Chain disconnected: c1 (0 remaining)');
    expect(tab.countCloses()).toBe(1);
  });

  it('As a worker whose service fails to let go of its chains, I am disposed without a throw and the failure is reported', async () => {
    // Given a synced worker whose service lets go of its chains and then throws
    const reports = recordReports({ onFinished: onTestFinished });
    const light = createFakeLightClient();
    const worker = await bootWorker(light, {
      startService(params) {
        const service = startLightClientService(params);
        return {
          ...service,
          dispose() {
            service.dispose();
            throw new Error('service release failed');
          },
        };
      },
    });

    // When the worker is disposed
    const thrown = catchError(worker.dispose);

    // Then nothing threw, the failure was reported, and each chain it opened was disconnected once
    expect(thrown).toBeUndefined();
    expect(reports.exceptions).toMatchObject([{ step: 'transition' }]);
    expect(light.disconnects.map(disconnect => disconnect.mock.calls.length)).toEqual([1, 1]);
  });

  it('As a worker that was disposed, I no longer hear the light client', async () => {
    // Given a worker that was disposed
    const light = createFakeLightClient();
    const worker = await bootWorker(light);
    worker.dispose();

    // When the light client dies
    light.die(FATAL);

    // Then nothing hears it, and the worker logged nothing of it
    expect(light.countListeners()).toBe(0);
    expect(worker.logs.filter(line => line.level === 'error')).toEqual([]);
  });

  it('As a worker that was disposed, I am disposed again and nothing throws', async () => {
    // Given a worker serving a tab, which was disposed
    const worker = await bootWorker(createFakeLightClient());
    await waitForReady(worker.connect());
    worker.dispose();

    // When it is disposed again
    const thrown = catchError(worker.dispose);

    // Then nothing threw
    expect(thrown).toBeUndefined();
  });

  it('As the shared worker, I close my chains once my only tab asks for a pause, and open them again when it resumes', async () => {
    // Given a synced worker serving one tab, and the connections its chains opened
    const light = createFakeLightClient();
    const worker = await bootWorker(light);
    const tab = worker.connect();
    const opened = [...light.opened];

    // When the tab asks for a pause
    await tab.transport.request(frame.pause, { paused: true });

    // Then each of those connections was disconnected
    expect(opened.length).toBeGreaterThan(0);
    expect(light.disconnects.map(disconnect => disconnect.mock.calls.length)).toEqual(opened.map(() => 1));

    // When the tab asks to resume
    await tab.transport.request(frame.pause, { paused: false });

    // Then each of those connections was opened a second time
    expect([...light.opened].sort()).toEqual([...opened, ...opened].sort());
  });
});

describe('worker lifecycle', () => {
  it('As a dead shared worker that is then marked ready, I stay failed and still close once my port heard why', async () => {
    // Given a lifecycle serving one port that subscribed to its status
    const { lifecycle, timers, close } = startLifecycle();
    const session = openSession(lifecycle);
    lifecycle.hear(session);

    // When the worker fails, is then marked ready, and its queued close runs
    lifecycle.fail(new Error(FATAL));
    lifecycle.markReady();
    await timers.advance(0);

    // Then it stayed failed and closed once
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('As the shared worker, I dispose my lifecycle twice and its heartbeat stops', () => {
    // Given a lifecycle beating a served port
    const { lifecycle, heartbeat } = startLifecycle();
    openSession(lifecycle);

    // When it is disposed, and disposed again
    lifecycle.dispose();
    lifecycle.dispose();

    // Then no beat runs
    expect(heartbeat.countRunning()).toBe(0);
  });

  it('As the shared worker, I hear that every tab asks for a pause once my last tab does', () => {
    // Given a lifecycle serving two tabs, the first of which asks for a pause
    const { lifecycle, everyTabPaused } = startLifecycle();
    const first = openSession(lifecycle);
    const second = openSession(lifecycle);
    lifecycle.markPaused(first, true);
    const heardBeforeLast = [...everyTabPaused];

    // When the second tab asks for a pause too
    lifecycle.markPaused(second, true);

    // Then only the last ask was heard, as every tab paused
    expect(heardBeforeLast).toEqual([]);
    expect(everyTabPaused).toEqual([true]);
  });

  it('As the shared worker, I hear the pause end when a paused tab resumes or a new tab connects', () => {
    // Given a lifecycle serving two tabs that both ask for a pause
    const { lifecycle, everyTabPaused } = startLifecycle();
    const first = openSession(lifecycle);
    const second = openSession(lifecycle);
    lifecycle.markPaused(first, true);
    lifecycle.markPaused(second, true);

    // When the first tab resumes, asks for a pause again, and a new tab then connects
    lifecycle.markPaused(first, false);
    lifecycle.markPaused(first, true);
    openSession(lifecycle);

    // Then each change was heard once, in order, and the pause ended with the new tab
    expect(everyTabPaused).toEqual([true, false, true, false]);
  });

  it("As the shared worker, I hear every tab paused once my only unpaused tab's port closes", () => {
    // Given a lifecycle serving a paused tab and an unpaused one
    const { lifecycle, everyTabPaused } = startLifecycle();
    const paused = openSession(lifecycle);
    const unpaused = openSession(lifecycle);
    lifecycle.markPaused(paused, true);

    // When the unpaused tab's port closes
    unpaused.leave();

    // Then every tab left asks for a pause
    expect(everyTabPaused).toEqual([true]);
  });

  it('As the shared worker, I hear every tab paused once the heartbeat releases my only unpaused tab', () => {
    // Given a lifecycle serving a paused tab and an unpaused one
    const { lifecycle, heartbeat, everyTabPaused } = startLifecycle();
    const paused = openSession(lifecycle);
    openSession(lifecycle);
    lifecycle.markPaused(paused, true);

    // When the heartbeat runs past the beats it allows, while only the paused tab speaks
    for (let round = 0; round <= HEARTBEAT_MISSED_BEATS; round++) {
      paused.speak();
      heartbeat.tick();
    }

    // Then the release of the silent tab left every tab paused
    expect(everyTabPaused).toEqual([true]);
  });

  it('As the shared worker whose last tab left, I keep my pause state', () => {
    // Given a lifecycle serving one tab that asks for a pause
    const { lifecycle, everyTabPaused } = startLifecycle();
    const session = openSession(lifecycle);
    lifecycle.markPaused(session, true);

    // When its port closes
    session.leave();

    // Then nothing more was heard, so the pause holds
    expect(everyTabPaused).toEqual([true]);
  });

  it('As the shared worker, I am asked for the scope of a port I released and refuse', () => {
    // Given a lifecycle whose only port the heartbeat released, as its tab missed every beat it allows
    const { lifecycle, heartbeat } = startLifecycle();
    const session = openSession(lifecycle);
    for (let round = 0; round <= HEARTBEAT_MISSED_BEATS; round++) {
      heartbeat.tick();
    }
    const open = vi.fn<() => EngineScope>();

    // When the scope of that port is asked for
    const thrown = catchError(() => lifecycle.getScope(session, open));

    // Then it is refused, and no scope was opened
    expect(thrown).toMatchObject({ message: 'The port is no longer served' });
    expect(open).not.toHaveBeenCalled();
  });

  it("As the shared worker, I am disposed while my first port's transport throws, and the failure is reported while my other port is still let go", () => {
    // Given a lifecycle serving two ports, the first of whose transport throws on dispose
    const reports = recordReports({ onFinished: onTestFinished });
    const { lifecycle } = startLifecycle();
    const first = openSession(lifecycle);
    const second = openSession(lifecycle);
    vi.spyOn(first.transport, 'dispose').mockImplementationOnce(() => {
      throw new Error('dispose failed');
    });
    const secondDispose = vi.spyOn(second.transport, 'dispose');

    // When the lifecycle is disposed
    const thrown = catchError(() => {
      lifecycle.dispose();
    });

    // Then nothing was thrown, the failure was reported, and the second port was let go
    expect(thrown).toBeUndefined();
    expect(reports.exceptions).toMatchObject([{ step: 'transition' }]);
    expect(secondDispose).toHaveBeenCalledTimes(1);
  });

  it('As the shared worker, I am told a served tab left while its transport throws on dispose, and the failure is reported while its scope still closes and its port is shut', () => {
    // Given a lifecycle serving a tab with an open scope, whose transport throws on dispose
    const reports = recordReports({ onFinished: onTestFinished });
    const { lifecycle } = startLifecycle();
    const session = openSession(lifecycle);
    const closeScope = vi.fn<() => void>();
    lifecycle.getScope(session, () => toFakeScope(closeScope));
    vi.spyOn(session.transport, 'dispose').mockImplementationOnce(() => {
      throw new Error('dispose failed');
    });
    const closePort = vi.spyOn(session.port, 'close');

    // When the tab's port closes
    const thrown = catchError(() => {
      session.leave();
    });

    // Then nothing was thrown, the failure was reported, and the scope and the port were still closed
    expect(thrown).toBeUndefined();
    expect(reports.exceptions).toMatchObject([{ step: 'transition' }]);
    expect(closeScope).toHaveBeenCalledTimes(1);
    expect(closePort).toHaveBeenCalledTimes(1);
  });

  it('As the shared worker, I release a tab whose status sink throws on its end, and the failure is reported while its transport still goes and its scope still closes', () => {
    // Given a lifecycle serving a tab with an open scope and a status sink that throws when ended
    const reports = recordReports({ onFinished: onTestFinished });
    const { lifecycle, heartbeat } = startLifecycle();
    const session = openSession(lifecycle);
    const closeScope = vi.fn<() => void>();
    lifecycle.getScope(session, () => toFakeScope(closeScope));
    lifecycle.addStatusSink(session, {
      send: () => undefined,
      interrupt: () => {
        throw new Error('interrupt failed');
      },
    });
    const dispose = vi.spyOn(session.transport, 'dispose');

    // When the tab misses every beat it is allowed
    const thrown = catchError(() => {
      for (let round = 0; round <= HEARTBEAT_MISSED_BEATS; round++) {
        heartbeat.tick();
      }
    });

    // Then nothing was thrown, the failure was reported, and the transport and the scope were still let go
    expect(thrown).toBeUndefined();
    expect(reports.exceptions).toMatchObject([{ step: 'transition' }]);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(closeScope).toHaveBeenCalledTimes(1);
  });
});

/** A scope that only records its close, for a case that never connects on it. */
function toFakeScope(close: () => void): EngineScope {
  return { close } as unknown as EngineScope;
}
