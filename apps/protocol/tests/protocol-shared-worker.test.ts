// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The SharedWorker module runs at import: it reads the network from its name,
// subscribes to the light client's fatal and starts pre-sync. The light client
// is faked at the `@dotli/resolver` seam, and the worker scope is happy-dom's
// window, which the module sees as `self`.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as MetricsModule from '@dotli/metrics';

const resolver = vi.hoisted(() => ({
  fatal: null as ((message: string) => void) | null,
  presync: (): Promise<void> => Promise.resolve(),
}));

vi.mock('@dotli/resolver', () => ({
  createChainProvider: () => null,
  isChainSupported: () => true,
  onProviderFatal: (cb: (message: string) => void) => {
    resolver.fatal = cb;
    return () => undefined;
  },
  onSmoldotDbOutcome: () => () => undefined,
  resolveDotName: () => Promise.resolve(null),
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
  initSentry: () => undefined,
  installGlobalErrorHandlers: () => undefined,
}));

interface FakePort {
  posted: Mock<(message: unknown) => void>;
  port: MessagePort;
  /** The tab's iframe unloads, and says so as it does on `beforeunload`. */
  leave: () => void;
}

function fakePort(): FakePort {
  const posted = vi.fn<(message: unknown) => void>();
  const listeners: ((event: MessageEvent) => void)[] = [];
  const port = {
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === 'message') {
        listeners.push(listener);
      }
    },
    start: () => undefined,
    postMessage: posted,
  } as unknown as MessagePort;
  const leave = (): void => {
    for (const listener of listeners) {
      listener(new MessageEvent('message', { data: { type: 'disconnect' } }));
    }
  };
  return { posted, port, leave };
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

const FATAL = 'chain 0xaa connection failed: wasm trap';

const fatalRelay = {
  type: 'relay-response',
  envelope: { namespace: 'dotli:protocol', kind: 'fatal', message: FATAL },
};

describe('protocol SharedWorker', () => {
  let warn: Mock<(...args: unknown[]) => void>;
  let error: Mock<(...args: unknown[]) => void>;
  // Each test imports a fresh worker, which adds its own `connect` listener to
  // the one window every test shares. Removed after each test, so a connect
  // reaches only the worker of the test that made it.
  let added: Parameters<typeof self.addEventListener>[];

  /** Run the worker module afresh, as a new SharedWorker would. */
  async function bootWorker(): Promise<void> {
    vi.resetModules();
    await import('../src/protocol-shared-worker.js');
    await flush();
  }

  beforeEach(() => {
    warn = vi.fn<(...args: unknown[]) => void>();
    error = vi.fn<(...args: unknown[]) => void>();
    vi.spyOn(console, 'warn').mockImplementation(warn);
    vi.spyOn(console, 'error').mockImplementation(error);
    added = [];
    const addEventListener = self.addEventListener.bind(self);
    vi.spyOn(self, 'addEventListener').mockImplementation((...args: Parameters<typeof self.addEventListener>) => {
      added.push(args);
      addEventListener(...args);
    });
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
    expect(error).toHaveBeenCalledWith('[dot.li SW]', 'Chain death detected, broadcasting fatal to 1 port(s)');
    expect(warn).toHaveBeenCalledWith('[dot.li SW]', 'Pre-sync complete, engine ready');
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
    expect(error).toHaveBeenCalledWith('[dot.li SW]', 'Chain death detected, broadcasting fatal to 1 port(s)');
    expect(warn).not.toHaveBeenCalledWith('[dot.li SW]', 'Pre-sync complete, engine ready');
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
    expect(error).toHaveBeenCalledWith('[dot.li SW]', 'Pre-sync failed: chainHead follow stopped');
  });

  it('As a dotli user on the shared light client, a worker whose light client died closes once its last tab leaves, so a reload starts a new one', async () => {
    // Given: two tabs on a worker whose light client then cannot connect a chain.
    await bootWorker();
    const close = vi.spyOn(self, 'close').mockImplementation(() => undefined);
    const first = connect();
    const second = connect();
    resolver.fatal?.(FATAL);

    // When: one tab leaves.
    first.leave();

    // Then: the other still holds the worker.
    expect(close).not.toHaveBeenCalled();

    // When: the last one leaves too.
    second.leave();

    // Then
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user on the shared light client, a working worker stays when its last tab leaves', async () => {
    // Given
    await bootWorker();
    const close = vi.spyOn(self, 'close').mockImplementation(() => undefined);
    const tab = connect();

    // When
    tab.leave();

    // Then
    expect(close).not.toHaveBeenCalled();
  });
});
