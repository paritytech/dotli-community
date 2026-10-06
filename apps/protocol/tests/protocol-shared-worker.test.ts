// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The SharedWorker module runs at import: it reads the network from its name,
// subscribes to the light client's fatal and starts pre-sync. The light client
// is faked at the `@dotli/resolver` seam, and the worker scope is happy-dom's
// window, which the module sees as `self`.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as MetricsModule from '@dotli/metrics';
import type { ProtocolRequestEnvelope } from '@dotli/protocol';
import type { ChainDetail, ChainSyncEvent } from '../../../packages/resolver/src/chain-sync.js';

const resolver = vi.hoisted(() => ({
  fatal: null as ((message: string) => void) | null,
  presync: (): Promise<void> => Promise.resolve(),
  resolveDotName: (): Promise<string | null> => Promise.resolve(null),
  // What the chains reported so far, replayed to each new subscriber as the
  // resolver does.
  sync: [] as ChainSyncEvent[],
  detail: [] as ChainDetail[],
  syncListeners: new Set<(event: ChainSyncEvent) => void>(),
  detailListeners: new Set<(detail: ChainDetail) => void>(),
}));

type SpanOpen = (typeof MetricsModule)['m']['open'];

const captureException = vi.hoisted(() => vi.fn<(err: unknown, ctx: unknown) => void>());

vi.mock('@dotli/resolver', () => ({
  createChainProvider: () => null,
  enableSyncReporting: () => undefined,
  isChainSupported: () => true,
  onChainSync: (cb: (event: ChainSyncEvent) => void) => {
    resolver.sync.forEach(cb);
    resolver.syncListeners.add(cb);
    return () => resolver.syncListeners.delete(cb);
  },
  onChainDetail: (cb: (detail: ChainDetail) => void) => {
    resolver.detail.forEach(cb);
    resolver.detailListeners.add(cb);
    return () => resolver.detailListeners.delete(cb);
  },
  onProviderFatal: (cb: (message: string) => void) => {
    resolver.fatal = cb;
    return () => undefined;
  },
  onSmoldotDbOutcome: () => () => undefined,
  resolveDotName: () => resolver.resolveDotName(),
  resolveExecutableManifest: () => Promise.resolve(null),
  resolveOwner: () => Promise.resolve(null),
  resolveRootManifest: () => Promise.resolve(null),
  setResolverAssetHubProvider: () => undefined,
  setResolverPeopleProvider: () => undefined,
  waitForAssetHubFinalized: () => resolver.presync(),
  // People warms in the background; it never settles here.
  waitForPeopleFinalized: () => new Promise<void>(() => undefined),
}));

vi.mock('@dotli/metrics', async importOriginal => ({
  ...(await importOriginal<typeof MetricsModule>()),
  captureException,
  initSentry: () => undefined,
  installGlobalErrorHandlers: () => undefined,
}));

interface FakePort {
  posted: Mock<(message: unknown) => void>;
  port: MessagePort;
  /** Deliver a message from the tab's iframe to the worker. */
  receive: (data: unknown) => void;
}

function fakePort(): FakePort {
  const posted = vi.fn<(message: unknown) => void>();
  const listeners: ((event: MessageEvent) => void)[] = [];
  const port = {
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
      listeners.push(listener);
    },
    start: () => undefined,
    postMessage: posted,
  } as unknown as MessagePort;
  return {
    posted,
    port,
    receive: data => {
      for (const listener of listeners) {
        listener({ data } as MessageEvent);
      }
    },
  };
}

/** Connect a port to the worker as a tab's protocol iframe would. */
function connect(): FakePort {
  const port = fakePort();
  const event = new Event('connect');
  Object.defineProperty(event, 'ports', { value: [port.port] });
  self.dispatchEvent(event);
  return port;
}

const flush = (): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, 0);
  });

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  let reject: (err: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** What a port was told, less the pings each later connect sends to find dead ports. */
function heard(port: FakePort): unknown[] {
  return port.posted.mock.calls.map(([message]) => message).filter(message => !isPing(message));
}

function isPing(message: unknown): boolean {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'ping';
}

/** The protocol envelopes a port was sent, of one kind. */
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

const FATAL = 'chain 0xaa connection failed: wasm trap';

const fatalRelay = {
  type: 'relay-response',
  envelope: { namespace: 'dotli:protocol', kind: 'fatal', message: FATAL },
};

describe('protocol SharedWorker', () => {
  let event: Mock<(name: string, attrs?: Record<string, unknown>) => void>;
  let error: Mock<(...args: unknown[]) => void>;
  let open: Mock<SpanOpen>;
  let closeWorker: Mock<() => void>;
  // Each test imports a fresh worker, which adds its own `connect` listener to
  // the one window every test shares. Removed after each test, so a connect
  // reaches only the worker of the test that made it.
  let added: Parameters<typeof self.addEventListener>[];

  /** Run the worker module afresh, as a new SharedWorker would, with the log and spans it writes to spied on. */
  async function bootWorker(): Promise<void> {
    vi.resetModules();
    const { log } = await import('@dotli/shared');
    const { m } = await import('@dotli/metrics');
    event = vi.fn<(name: string, attrs?: Record<string, unknown>) => void>();
    error = vi.fn<(...args: unknown[]) => void>();
    vi.spyOn(log, 'event').mockImplementation(event);
    vi.spyOn(log, 'error').mockImplementation(error);
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    open = vi.fn<SpanOpen>(() => ({
      setAttributes: () => undefined,
      child: () => {
        throw new Error('no child spans expected');
      },
      end: () => undefined,
    }));
    vi.spyOn(m, 'open').mockImplementation(open);
    await import('../src/protocol-shared-worker.js');
    await flush();
  }

  beforeEach(() => {
    captureException.mockReset();
    resolver.sync = [];
    resolver.detail = [];
    resolver.syncListeners.clear();
    resolver.detailListeners.clear();
    resolver.resolveDotName = () => Promise.resolve(null);
    added = [];
    const addEventListener = self.addEventListener.bind(self);
    vi.spyOn(self, 'addEventListener').mockImplementation((...args: Parameters<typeof self.addEventListener>) => {
      added.push(args);
      addEventListener(...args);
    });
    closeWorker = vi.fn<() => void>();
    vi.spyOn(self, 'close').mockImplementation(closeWorker);
    window.name = 'dotli-protocol-paseo-next-v2';
    resolver.presync = () => Promise.resolve();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [type, listener, options] of added) {
      self.removeEventListener(type, listener, options);
    }
  });

  it('As a dotli user on the shared light client, a tab that joins after the light client died hears why instead of ready', async () => {
    // Given: a tab on a synced worker whose light client then cannot connect a chain.
    await bootWorker();
    const first = connect();
    expect(first.posted).toHaveBeenCalledWith({ type: 'ready' });
    resolver.fatal?.(FATAL);

    // When: another tab, or the same one after its retry, connects.
    const later = connect();

    // Then: it is told the light client is dead, and never that it is ready.
    expect(first.posted).toHaveBeenCalledWith(fatalRelay);
    expect(later.posted.mock.calls).toEqual([[{ type: 'error', message: FATAL }]]);
    expect(error).toHaveBeenCalledWith(`[dot.li SW] Light client died, broadcasting fatal to 1 port(s): ${FATAL}`);
    expect(event).toHaveBeenCalledWith('Pre-sync complete', expect.objectContaining({ flow: 'protocol' }));
  });

  it('As a dotli user on the shared light client, a light client that dies while Asset Hub syncs never tells a waiting tab it is ready', async () => {
    // Given: a tab waiting on a pre-sync still under way.
    const presync = deferred();
    resolver.presync = () => presync.promise;
    await bootWorker();
    const waiting = connect();

    // When: the light client cannot connect a chain, and then Asset Hub syncs anyway.
    resolver.fatal?.(FATAL);
    presync.resolve();
    await flush();
    const later = connect();

    // Then: the waiting tab heard only the fatal, and the engine never became ready.
    expect(heard(waiting)).toEqual([fatalRelay]);
    expect(later.posted.mock.calls).toEqual([[{ type: 'error', message: FATAL }]]);
    expect(error).toHaveBeenCalledWith(`[dot.li SW] Light client died, broadcasting fatal to 1 port(s): ${FATAL}`);
    expect(event).not.toHaveBeenCalledWith('Pre-sync complete', expect.anything());
  });

  it('As a dotli user on the shared light client, a tab waiting on pre-sync is told why the light client died, once', async () => {
    // Given: a tab waiting on a pre-sync still under way.
    const presync = deferred();
    resolver.presync = () => presync.promise;
    await bootWorker();
    const waiting = connect();

    // When: the light client cannot connect a chain, and pre-sync then fails for it.
    resolver.fatal?.(FATAL);
    presync.reject(new Error('chainHead follow stopped'));
    await flush();
    const later = connect();

    // Then: both tabs hear the cause, not its symptom, and the waiting one only once.
    expect(heard(waiting)).toEqual([fatalRelay]);
    expect(later.posted.mock.calls).toEqual([[{ type: 'error', message: FATAL }]]);
    expect(error).toHaveBeenCalledWith('[dot.li SW] Pre-sync failed: chainHead follow stopped', expect.any(Error));
  });

  it("As a dotli user on the shared light client, my tab's loading screen hears how the shared chains sync", async () => {
    // Given: a tab waiting on a pre-sync still under way.
    resolver.presync = () => new Promise<void>(() => undefined);
    await bootWorker();
    const waiting = connect();

    // When: the relay reports its warp progress.
    const progress: ChainSyncEvent = { chain: 'relay', kind: 'warpSyncProgress', at: 10, target: 100 };
    for (const listener of resolver.syncListeners) {
      listener(progress);
    }

    // Then: the tab hears it as the envelope direct mode sends.
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

  it('As a dotli user on the shared light client, a tab that joins a synced worker hears where the chains stand, and that it started warm', async () => {
    // Given: a synced worker whose own first start found Asset Hub cold on disk.
    resolver.sync = [{ chain: 'asset-hub', kind: 'bootstrapComplete' }];
    resolver.detail = [{ chain: 'asset-hub', dbCache: 'miss' }];
    await bootWorker();

    // When: another tab connects.
    const later = connect();

    // Then: it hears the chain is up, and pays no sync cost for it.
    expect(envelopes(later, 'chain-sync')).toEqual([
      { namespace: 'dotli:protocol', kind: 'chain-sync', chain: 'asset-hub', syncKind: 'bootstrapComplete' },
    ]);
    expect(envelopes(later, 'chain-detail')).toEqual([
      { namespace: 'dotli:protocol', kind: 'chain-detail', chain: 'asset-hub', dbCache: 'hit' },
    ]);
  });

  it('As a dotli user on the shared light client, a closed tab stops hearing chain sync', async () => {
    // Given
    await bootWorker();
    const tab = connect();

    // When
    tab.receive({ type: 'disconnect' });

    // Then
    expect(resolver.syncListeners.size).toBe(0);
    expect(resolver.detailListeners.size).toBe(0);
  });

  it('As a dotli maintainer, a failed request tells the host where it was thrown', async () => {
    // Given
    const failure = new Error('storage read failed');
    resolver.resolveDotName = () => Promise.reject(failure);
    await bootWorker();
    const tab = connect();

    // When
    tab.receive(relayRequest({ method: 'resolveDotName', payload: { label: 'doom' } }));
    await flush();

    // Then
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
    // Given
    await bootWorker();
    const tab = connect();

    // When
    tab.receive(relayRequest({ method: 'resolveDotName', payload: { label: 'doom' } }, 'load-1'));
    tab.receive(relayRequest({ id: 'r2', method: 'warmup' }, 'not a resolution id!'));
    await flush();

    // Then: only a well-formed id is recorded, and only on that request's span.
    expect(open.mock.calls).toEqual([
      ['protocol.worker_request', { root: true, attributes: { method: 'resolveDotName', resolution_id: 'load-1' } }],
      ['protocol.worker_request', { root: true, attributes: { method: 'warmup' } }],
    ]);
  });

  it('As a dotli maintainer, a message the worker cannot deliver to a tab is reported, since the host never hears of it', async () => {
    // Given
    await bootWorker();
    const tab = connect();
    const failure = new DOMException('could not be cloned', 'DataCloneError');
    tab.posted.mockImplementation(message => {
      if ((message as { type?: unknown }).type === 'relay-response') {
        throw failure;
      }
    });

    // When
    tab.receive(relayRequest({ method: 'warmup' }));
    await flush();

    // Then
    expect(captureException).toHaveBeenCalledWith(failure, {
      flow: 'protocol',
      step: 'worker_port_send',
      tags: { envelope_kind: 'response' },
    });
  });

  it('halts every attached tab on an uncaught worker error and fences late results from the retired generation', async () => {
    const pending = deferred();
    resolver.resolveDotName = async () => {
      await pending.promise;
      return null;
    };
    await bootWorker();
    const first = connect();
    const second = connect();
    first.receive({
      type: 'relay-request',
      envelope: {
        namespace: 'dotli:protocol',
        kind: 'request',
        id: 'pending-read',
        method: 'resolveDotName',
        payload: { label: 'example' },
      },
      origin: 'https://example.dot.li',
    });

    self.dispatchEvent(new ErrorEvent('error', { message: FATAL }));
    pending.resolve();
    await flush();
    first.receive({
      type: 'relay-request',
      envelope: { namespace: 'dotli:protocol', kind: 'request', id: 'late-read', method: 'warmup', payload: {} },
      origin: 'https://example.dot.li',
    });
    self.dispatchEvent(new ErrorEvent('error', { message: 'second failure' }));

    expect(heard(first)).toEqual([{ type: 'ready' }, fatalRelay]);
    expect(heard(second)).toEqual([{ type: 'ready' }, fatalRelay]);
    expect(closeWorker).toHaveBeenCalledTimes(1);
    expect(heard(connect())).toEqual([]);
  });

  it('retires a crashed worker during pre-sync without announcing ready when that old sync completes', async () => {
    const pending = deferred();
    resolver.presync = () => pending.promise;
    await bootWorker();
    const waiting = connect();
    self.dispatchEvent(new ErrorEvent('error', { message: FATAL }));
    pending.resolve();
    await flush();

    expect(heard(waiting)).toEqual([fatalRelay]);
    expect(closeWorker).toHaveBeenCalledTimes(1);
  });
});
