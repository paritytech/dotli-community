// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { TrUApiProductProvider } from '@parity/truapi-host';
import type { WorkerPairingHostRuntime } from '@parity/truapi-host/web';
import { bindCaptureSink } from '@dotli/metrics';
import { createAsyncTaskPool, type Timers } from '@dotli/shared';
import { manualTimers, recordLog } from '@dotli/shared/testing';
import { createBlockingModalCoordinator } from './blocking-modal-queue.js';
import type { BootedCoreRuntime, CoreRuntimeRequest } from './core-runtime.js';
import { CoreRedialError, createPageCore, type PageCore } from './page-core.js';
import { labelToProductId } from './runtime-config.js';
import { garbageRequestFrame, requestFrame, responseFrame, SIGN_RAW_BODY } from './phone-requests.fake.js';
import { createPhoneRequestTracker, type PhoneRequestTracker } from './phone-requests.js';
import { createChanges, type Changes } from '../testing/changes.js';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';

interface FakeProvider {
  provider: TrUApiProductProvider;
  dispose: ReturnType<typeof vi.fn<() => void>>;
  /** Every frame posted to the core, in order. */
  posted: Uint8Array[];
  /** The core sending a frame to its subscribers. */
  send(message: Uint8Array): void;
  /** The core going down under the connection. */
  goDown(): void;
}

interface FakeRuntime {
  runtime: WorkerPairingHostRuntime;
  createProvider: ReturnType<typeof vi.fn<WorkerPairingHostRuntime['createProvider']>>;
  cancelPairing: ReturnType<typeof vi.fn<() => void>>;
  notifySessionStoreChanged: ReturnType<typeof vi.fn<() => void>>;
  resetSessionState: ReturnType<typeof vi.fn<() => Promise<void>>>;
  dispose: ReturnType<typeof vi.fn<() => void>>;
  providers: FakeProvider[];
}

function fakeProvider(changes: Changes): FakeProvider {
  const listeners = new Set<(error: Error) => void>();
  const closeAll = (error: Error): void => {
    for (const listener of [...listeners]) {
      listener(error);
    }
  };
  // A deliberate dispose fires close listeners too, as the real provider does.
  const dispose = vi.fn(() => {
    closeAll(new Error('disposed'));
    changes.notify();
  });
  const posted: Uint8Array[] = [];
  const subscribers = new Set<(message: Uint8Array) => void>();
  const provider = {
    postMessage: (message: Uint8Array) => {
      posted.push(message);
    },
    subscribe: (listener: (message: Uint8Array) => void) => {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    subscribeClose: (listener: (error: Error) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose,
  } as unknown as TrUApiProductProvider;
  return {
    provider,
    dispose,
    posted,
    send: message => {
      for (const subscriber of [...subscribers]) {
        subscriber(message);
      }
    },
    goDown: () => {
      closeAll(new Error('worker gone'));
    },
  };
}

function fakeRuntime(changes: Changes): FakeRuntime {
  const providers: FakeProvider[] = [];
  const createProvider = vi.fn<WorkerPairingHostRuntime['createProvider']>(() => {
    const provider = fakeProvider(changes);
    providers.push(provider);
    changes.notify();
    return Promise.resolve(provider.provider);
  });
  const cancelPairing = vi.fn(changes.notify);
  const notifySessionStoreChanged = vi.fn(changes.notify);
  const resetSessionState = vi.fn(() => {
    changes.notify();
    return Promise.resolve();
  });
  const dispose = vi.fn(changes.notify);
  const runtime = {
    createProvider,
    cancelPairing,
    notifySessionStoreChanged,
    resetSessionState,
    dispose,
  } as unknown as WorkerPairingHostRuntime;
  return { runtime, createProvider, cancelPairing, notifySessionStoreChanged, resetSessionState, dispose, providers };
}

type Boot = (request: CoreRuntimeRequest) => Promise<BootedCoreRuntime>;

interface Harness {
  core: PageCore;
  /** Every runtime a boot attempt produced, in order. */
  runtimes: FakeRuntime[];
  requests: CoreRuntimeRequest[];
  /** How each boot attempt settled, in order, recorded before the page core handles it. */
  outcomes: ('ok' | 'error')[];
  storeListeners: Set<() => void>;
  /** Queues how the next boot attempts end. An attempt with nothing queued boots at once. */
  nextBoots: Boot[];
  /** Every stale check the page core made, in order. */
  staleChecks: Promise<boolean>[];
  /** Notified at each boot request and outcome, store listener change and call on a fake runtime or connection. */
  changes: Changes;
}

interface HarnessOptions {
  local?: boolean;
  /** Makes each core's phone request tracker. */
  createPhoneRequests?: () => PhoneRequestTracker;
  /** Whether a wallet read now finds the local wallet, which makes a pairing core stale. */
  walletFound?: () => boolean;
  onCoresGone?: () => void;
  /** How long a core outlives its last lease. Default 0, which disposes at once. */
  destroyDelay?: number;
  /** The timers the destroy delay runs on. The real ones by default. */
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
}

function harness(options: HarnessOptions = {}): Harness {
  const runtimes: FakeRuntime[] = [];
  const requests: CoreRuntimeRequest[] = [];
  const nextBoots: Boot[] = [];
  const storeListeners = new Set<() => void>();
  const staleChecks: Promise<boolean>[] = [];
  const outcomes: ('ok' | 'error')[] = [];
  const changes = createChanges();
  const bootNow: Boot = () => {
    const runtime = fakeRuntime(changes);
    runtimes.push(runtime);
    // As the real boot does, a wallet read that finds the wallet boots a local core, which is never stale.
    const local = options.local ?? options.walletFound?.() ?? false;
    return Promise.resolve({
      runtime: runtime.runtime,
      local,
      stale: () => {
        const check = local ? Promise.resolve(false) : Promise.resolve(options.walletFound?.() ?? false);
        staleChecks.push(check);
        return check;
      },
    });
  };
  const core = createPageCore({
    bootRuntime: request => {
      requests.push(request);
      changes.notify();
      const attempt = (nextBoots.shift() ?? bootNow)(request);
      attempt.then(
        () => {
          outcomes.push('ok');
          changes.notify();
        },
        () => {
          outcomes.push('error');
          changes.notify();
        },
      );
      return attempt;
    },
    onStoredSessionChanged: listener => {
      storeListeners.add(listener);
      changes.notify();
      return () => {
        storeListeners.delete(listener);
        changes.notify();
      };
    },
    coordinator: createBlockingModalCoordinator(),
    redials: createAsyncTaskPool({ poolSize: 1, retryCount: 2 }),
    destroyDelay: options.destroyDelay ?? 0,
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...(options.createPhoneRequests === undefined ? {} : { createPhoneRequests: options.createPhoneRequests }),
    ...(options.onCoresGone === undefined ? {} : { onCoresGone: options.onCoresGone }),
  });
  return { core, runtimes, requests, outcomes, storeListeners, nextBoots, staleChecks, changes };
}

function failingBoot(): Boot {
  return () => Promise.reject(new Error('worker failed to start'));
}

function heldBoot(changes: Changes): { boot: Boot; resolve: () => FakeRuntime } {
  let resolveBoot!: (booted: BootedCoreRuntime) => void;
  const pending = new Promise<BootedCoreRuntime>(resolve => {
    resolveBoot = resolve;
  });
  return {
    boot: () => pending,
    resolve: () => {
      const runtime = fakeRuntime(changes);
      resolveBoot({ runtime: runtime.runtime, local: false, stale: () => Promise.resolve(false) });
      return runtime;
    },
  };
}

function nthRuntime(runtimes: FakeRuntime[], index: number): FakeRuntime {
  const runtime = runtimes[index];
  if (runtime === undefined) {
    throw new Error(`no runtime ${String(index)}`);
  }
  return runtime;
}

/** A harness with a fake Sentry and capture sink bound for this test. */
function reportingHarness(
  options: HarnessOptions = {},
): Harness & { counted: RecordingSentry['counted']; captures: { exception: ReturnType<typeof vi.fn> } } {
  const fakes = harness(options);
  const metrics = bindRecordingSentry({ onFinished: onTestFinished, onRecord: fakes.changes.notify });
  const captures = { exception: vi.fn(fakes.changes.notify), expected: vi.fn() };
  onTestFinished(bindCaptureSink(captures));
  return { ...fakes, counted: metrics.counted, captures };
}

/** A real tracker whose taps record every frame they are told of first, and then throw if `broken`. */
function recordingTracker({ broken = false }: { broken?: boolean } = {}): {
  tracker: PhoneRequestTracker;
  fromProduct: Uint8Array[];
  fromCore: Uint8Array[];
} {
  const real = createPhoneRequestTracker();
  const fromProduct: Uint8Array[] = [];
  const fromCore: Uint8Array[] = [];
  const recorded = (frames: Uint8Array[], next: (message: Uint8Array) => void) => (message: Uint8Array) => {
    frames.push(message);
    if (broken) {
      throw new Error('tap broke');
    }
    next(message);
  };
  return {
    tracker: {
      ...real,
      connect() {
        const tap = real.connect();
        return {
          ...tap,
          fromProduct: recorded(fromProduct, tap.fromProduct),
          fromCore: recorded(fromCore, tap.fromCore),
        };
      },
    },
    fromProduct,
    fromCore,
  };
}

function trackerOf(request: CoreRuntimeRequest | undefined): PhoneRequestTracker {
  if (request === undefined) {
    throw new Error('no core was requested');
  }
  return request.phoneRequests;
}

describe('page core', () => {
  it('As a page signed out elsewhere, I reset the session and the core my product holds drops it', async () => {
    // Given a page core already running
    const { core, runtimes } = harness();
    await core.acquire();

    // When the session is reset
    await core.resetSession();

    // Then the running core reset its session state
    expect(nthRuntime(runtimes, 0).resetSessionState).toHaveBeenCalledTimes(1);
  });

  it('As a page signed out elsewhere with no core running, I reset the session and no core boots to drop one', async () => {
    // Given a page core that never booted
    const { core, requests } = harness();

    // When the session is reset
    await core.resetSession();

    // Then no core was booted
    expect(requests).toHaveLength(0);
  });

  it('As a page signed out elsewhere while my core is still booting, I reset the session and a boot that fails leaves nothing to drop', async () => {
    // Given: a core whose boot is in flight
    const { core, nextBoots } = harness();
    const boot = Promise.withResolvers<BootedCoreRuntime>();
    nextBoots.push(() => boot.promise);
    const lease = core.acquire();

    // When the session is reset and the boot then fails
    const reset = core.resetSession();
    boot.reject(new Error('worker failed to start'));

    // Then the lease fails with the boot and the reset settles
    await expect(lease).rejects.toThrow('worker failed to start');
    await expect(reset).resolves.toBeUndefined();
  });

  it('As a page, I release my last lease and take a new one within the destroy delay and keep the same core', async () => {
    // Given a core whose only lease was released
    const timers = manualTimers();
    const { core, requests, runtimes } = harness({ destroyDelay: 5000, timers });
    const first = await core.acquire();
    first.release();

    // When the delay has almost run out and a new lease is taken
    await timers.advance(4999);
    await core.acquire();

    // Then the same core serves it, nothing was disposed and no timer is left
    expect(requests).toHaveLength(1);
    expect(nthRuntime(runtimes, 0).dispose).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(0);
  });

  it('As a page, I release my last lease and the core goes once the destroy delay ends', async () => {
    // Given a core whose only lease was released
    const timers = manualTimers();
    const onCoresGone = vi.fn();
    const { core, runtimes } = harness({ destroyDelay: 5000, timers, onCoresGone });
    const lease = await core.acquire();
    lease.release();

    // Then the core still lingers
    expect(nthRuntime(runtimes, 0).dispose).not.toHaveBeenCalled();
    expect(onCoresGone).not.toHaveBeenCalled();

    // When the destroy delay ends
    await timers.advance(5000);

    // Then the core is disposed once and the page hears its last core go
    expect(nthRuntime(runtimes, 0).dispose).toHaveBeenCalledTimes(1);
    expect(onCoresGone).toHaveBeenCalledTimes(1);
  });

  it('As a page whose lingering core goes down, I see it go at once', async () => {
    // Given a lingering core that has a connection
    const timers = manualTimers();
    const { core, runtimes } = harness({ destroyDelay: 5000, timers });
    const lease = await core.acquire();
    await lease.connect();
    lease.release();
    expect(nthRuntime(runtimes, 0).dispose).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(1);

    // When its connection closes
    const provider = nthRuntime(runtimes, 0).providers[0];
    if (provider === undefined) {
      throw new Error('no provider was connected');
    }
    provider.goDown();

    // Then it is disposed at once and its timer is cleared
    expect(nthRuntime(runtimes, 0).dispose).toHaveBeenCalledTimes(1);
    expect(timers.pending()).toBe(0);
  });

  it('As a page that changes product, I see a lingering core go at once', async () => {
    // Given a lingering core
    const timers = manualTimers();
    const { core, runtimes } = harness({ destroyDelay: 5000, timers });
    const lease = await core.acquire();
    lease.release();
    expect(nthRuntime(runtimes, 0).dispose).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(1);

    // When the page names another product
    core.setProduct({ label: 'other' });

    // Then the core is disposed at once and its timer is cleared
    expect(nthRuntime(runtimes, 0).dispose).toHaveBeenCalledTimes(1);
    expect(timers.pending()).toBe(0);
  });

  it('As a page that changed product while a login held the old core, I release the login and the old core goes at once', async () => {
    // Given a core held by a login while the page moves to another product
    const timers = manualTimers();
    const { core, runtimes } = harness({ destroyDelay: 5000, timers });
    const lease = await core.acquire();
    core.setProduct({ label: 'other' });

    // When the login releases it
    lease.release();

    // Then the old core is disposed at once, with no timer
    expect(nthRuntime(runtimes, 0).dispose).toHaveBeenCalledTimes(1);
    expect(timers.pending()).toBe(0);
  });

  it('As a page signed out elsewhere, I reset the session and my lingering core drops it', async () => {
    // Given a lingering core
    const timers = manualTimers();
    const { core, runtimes } = harness({ destroyDelay: 5000, timers });
    const lease = await core.acquire();
    lease.release();

    // When the session is reset
    await core.resetSession();

    // Then the core dropped its session and was not disposed
    expect(nthRuntime(runtimes, 0).resetSessionState).toHaveBeenCalledTimes(1);
    expect(nthRuntime(runtimes, 0).dispose).not.toHaveBeenCalled();
  });

  it('As a dApp user, I open a product and the page core boots one core for it', async () => {
    // Given
    const { core, requests, outcomes } = harness();

    // When
    await core.acquire();

    // Then
    expect(requests).toHaveLength(1);
    expect(outcomes).toEqual(['ok']);
  });

  it("As a dApp user, my frames pass the connection unchanged both ways and my core's tracker hears each one", async () => {
    // Given
    const recording = recordingTracker();
    const { core, runtimes } = harness({ createPhoneRequests: () => recording.tracker });
    const lease = await core.acquire();
    const connection = await lease.connect();
    const toProduct: Uint8Array[] = [];
    connection.provider.subscribe(message => toProduct.push(message));
    const request = requestFrame('r1', 'signRaw', SIGN_RAW_BODY);
    const response = responseFrame('r1', 'signRaw', { ok: { signature: '0x01' } });

    // When
    connection.provider.postMessage(request);
    nthRuntime(runtimes, 0).providers[0]?.send(response);

    // Then
    expect(nthRuntime(runtimes, 0).providers[0]?.posted).toEqual([request]);
    expect(toProduct).toEqual([response]);
    expect(recording.fromProduct).toEqual([request]);
    expect(recording.fromCore).toEqual([response]);
  });

  it("As a dApp user, my request is claimed from my core's tracker and closing my connection ends the claim as gone", async () => {
    // Given
    const { core, requests } = harness();
    const lease = await core.acquire();
    const connection = await lease.connect();
    connection.provider.postMessage(requestFrame('r1', 'signRaw', SIGN_RAW_BODY));
    const claim = trackerOf(requests[0]).claim(() => true);

    // When
    connection.close();

    // Then
    expect(claim?.request.method).toBe('signRaw');
    await expect(claim?.ended).resolves.toEqual({ kind: 'gone' });
  });

  it('As a dApp user, a tap that throws is reported and my frames still pass both ways', async () => {
    // Given
    const recording = recordingTracker({ broken: true });
    const { core, runtimes, captures } = reportingHarness({ createPhoneRequests: () => recording.tracker });
    recordLog({ onFinished: onTestFinished, level: 'error' });
    const lease = await core.acquire();
    const connection = await lease.connect();
    const toProduct: Uint8Array[] = [];
    connection.provider.subscribe(message => toProduct.push(message));
    const request = requestFrame('r1', 'signRaw', SIGN_RAW_BODY);
    const response = responseFrame('r1', 'signRaw', { ok: { signature: '0x01' } });

    // When
    connection.provider.postMessage(request);
    nthRuntime(runtimes, 0).providers[0]?.send(response);

    // Then
    expect(nthRuntime(runtimes, 0).providers[0]?.posted).toEqual([request]);
    expect(toProduct).toEqual([response]);
    expect(captures.exception).toHaveBeenCalledTimes(2);
  });

  it('As a page, I redial a core and get a new tracker while the old one ends its claims as gone', async () => {
    // Given a request in flight on the first core, claimed
    const { core, runtimes, requests, changes } = harness();
    const lease = await core.acquire();
    const connection = await lease.connect();
    connection.provider.postMessage(requestFrame('r1', 'signRaw', SIGN_RAW_BODY));
    const first = trackerOf(requests[0]);
    const claim = first.claim(() => true);

    // When the core goes down and is redialed, and the old core goes with its last lease
    nthRuntime(runtimes, 0).providers[0]?.goDown();
    await changes.until(() => requests.length === 2);
    lease.release();

    // Then
    expect(trackerOf(requests[1])).not.toBe(first);
    await expect(claim?.ended).resolves.toEqual({ kind: 'gone' });
  });

  it('As a local wallet user, I use a product and none of its requests are tracked', async () => {
    // Given a local wallet core
    const { core, requests, captures } = reportingHarness({ local: true });
    const lease = await core.acquire();
    const connection = await lease.connect();

    // When a frame the tracker could not decode, and a sign request, pass the connection
    connection.provider.postMessage(garbageRequestFrame('r1', 'signRaw'));
    connection.provider.postMessage(requestFrame('r2', 'signRaw', SIGN_RAW_BODY));

    // Then nothing is reported and nothing can be claimed
    expect(captures.exception).not.toHaveBeenCalled();
    expect(trackerOf(requests[0]).claim(() => true)).toBeUndefined();
  });

  it('As a dApp user, I use one core from two parts of the page and it goes with the last lease', async () => {
    // Given
    const { core, runtimes, requests, outcomes, changes } = harness();
    const first = await core.acquire();
    const second = await core.acquire();

    // When
    first.release();
    first.release();
    second.release();

    // Then
    await changes.until(() => nthRuntime(runtimes, 0).dispose.mock.calls.length === 1);
    expect(requests).toHaveLength(1);
    expect(outcomes).toEqual(['ok']);
  });

  it('As a page whose last core goes with its last lease, I am told once, and not while another core lives', async () => {
    // Given two leases on one core
    let gone = 0;
    const { core } = harness({
      onCoresGone: () => {
        gone += 1;
      },
    });
    const first = await core.acquire();
    const second = await core.acquire();

    // When the first goes
    first.release();

    // Then the core still lives
    expect(gone).toBe(0);

    // When the last goes
    second.release();
    second.release();

    // Then the page heard once that its last core went
    expect(gone).toBe(1);
  });

  it('As a dApp user, I close a connection and the core stays ready without being dialed again', async () => {
    // Given
    const { core, requests } = harness();
    const lease = await core.acquire();
    const connection = await lease.connect();

    // When
    connection.close();

    // Then
    expect(requests[0]?.inService()).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it('As a dApp user whose core fails to boot, my request fails and one boot is attempted', async () => {
    // Given
    const { core, requests, outcomes, nextBoots } = harness();
    nextBoots.push(failingBoot());

    // When
    const lease = core.acquire();

    // Then
    await expect(lease).rejects.toThrow('worker failed to start');
    expect(requests).toHaveLength(1);
    expect(outcomes).toEqual(['error']);
  });

  it('As a dApp user whose core failed to boot, my next request dials a new core', async () => {
    // Given
    const { core, requests, outcomes, nextBoots } = harness();
    nextBoots.push(failingBoot());
    await expect(core.acquire()).rejects.toThrow();

    // When
    await core.acquire();

    // Then
    expect(requests).toHaveLength(2);
    expect(outcomes).toEqual(['error', 'ok']);
  });

  it('As a dApp user whose core goes down under my product, I get a new core dialed without asking', async () => {
    // Given
    const { core, runtimes, requests, outcomes, changes } = harness();
    const lease = await core.acquire();
    await lease.connect();

    // When
    nthRuntime(runtimes, 0).providers[0]?.goDown();

    // Then
    await changes.until(() => outcomes.length === 2 && outcomes.at(-1) === 'ok');
    expect(outcomes).toEqual(['ok', 'ok']);
    expect(requests).toHaveLength(2);
    const next = await core.acquire();
    expect(next.runtime).toBe(nthRuntime(runtimes, 1).runtime);
    expect(requests).toHaveLength(2);
  });

  it('As a dApp user whose core refuses a connection, I see my request fail and a new core dialed', async () => {
    // Given
    const { core, runtimes, requests, outcomes, changes } = harness();
    const lease = await core.acquire();
    nthRuntime(runtimes, 0).createProvider.mockRejectedValueOnce(new Error('runtime disposed'));

    // When
    const connection = lease.connect();

    // Then
    await expect(connection).rejects.toThrow('runtime disposed');
    await changes.until(() => outcomes.length === 2 && outcomes.at(-1) === 'ok');
    expect(requests).toHaveLength(2);
  });

  it('As a dApp user whose core goes down under two connections, I get one new core dialed', async () => {
    // Given
    const { core, runtimes, requests, outcomes, changes } = harness();
    const lease = await core.acquire();
    await lease.connect();
    await lease.connect();

    // When
    for (const provider of nthRuntime(runtimes, 0).providers) {
      provider.goDown();
    }

    // Then
    await changes.until(() => outcomes.length === 2 && outcomes.at(-1) === 'ok');
    expect(requests).toHaveLength(2);
  });

  it('As a holder of a core lease, I hear once that its core went down, when its replacement is already the one a request gets', async () => {
    // Given
    const { core, runtimes, requests } = harness();
    const lease = await core.acquire();
    await lease.connect();
    await lease.connect();
    const heard: number[] = [];
    lease.subscribeDown(() => {
      heard.push(requests.length);
    });

    // When
    for (const provider of nthRuntime(runtimes, 0).providers) {
      provider.goDown();
    }

    // Then
    expect(heard).toEqual([2]);
  });

  it('As a holder of a core lease, I still hear my core go down when a holder before me throws, and the throw is reported', async () => {
    // Given two holders of one core, the first throwing
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const { core, runtimes } = harness();
    const lease = await core.acquire();
    await lease.connect();
    lease.subscribeDown(() => {
      throw new TypeError('listener broke');
    });
    const heard = vi.fn();
    lease.subscribeDown(heard);

    // When the core goes down
    nthRuntime(runtimes, 0).providers[0]?.goDown();

    // Then the second holder heard it and the throw was counted under its owner
    expect(heard).toHaveBeenCalledTimes(1);
    expect(sentry.counted('listener.delivery')).toEqual([
      { outcome: 'error', reason: 'TypeError', owner: 'page_core.down' },
    ]);
  });

  it('As a holder of a lease whose core already went down, I hear it as I subscribe', async () => {
    // Given
    const { core, runtimes } = harness();
    const lease = await core.acquire();
    await lease.connect();
    nthRuntime(runtimes, 0).providers[0]?.goDown();
    const heard = vi.fn();

    // When
    lease.subscribeDown(heard);

    // Then
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('As a holder of a core lease who unsubscribed, I do not hear its core go down', async () => {
    // Given
    const { core, runtimes } = harness();
    const lease = await core.acquire();
    await lease.connect();
    const heard = vi.fn();
    lease.subscribeDown(heard)();

    // When
    nthRuntime(runtimes, 0).providers[0]?.goDown();

    // Then
    expect(heard).not.toHaveBeenCalled();
  });

  it('As a holder of a core lease, I release it and do not hear its core go down under a lease still held', async () => {
    // Given two leases on one core, and the first subscribed to its going down
    const { core, runtimes } = harness();
    const released = await core.acquire();
    const held = await core.acquire();
    await held.connect();
    const releasedHeard = vi.fn();
    const heldHeard = vi.fn();
    released.subscribeDown(releasedHeard);
    held.subscribeDown(heldHeard);

    // When the first lease goes, then the core goes down under the second
    released.release();
    nthRuntime(runtimes, 0).providers[0]?.goDown();

    // Then only the lease still held hears it
    expect(releasedHeard).not.toHaveBeenCalled();
    expect(heldHeard).toHaveBeenCalledTimes(1);
  });

  it('As a holder of the last core lease, I release it and nothing reports the core going down after', async () => {
    // Given a connection on a core whose last lease subscribed to its going down
    const { core, runtimes, requests, outcomes } = harness();
    const lease = await core.acquire();
    await lease.connect();
    const heard = vi.fn();
    lease.subscribeDown(heard);

    // When the lease goes, and the core's connection closes as its runtime goes with it
    lease.release();
    nthRuntime(runtimes, 0).providers[0]?.goDown();

    // Then nobody hears it, no core is dialed again and the runtime is disposed once
    expect(heard).not.toHaveBeenCalled();
    expect(lease.subscribeDown(heard)).toBeTypeOf('function');
    expect(heard).not.toHaveBeenCalled();
    expect(nthRuntime(runtimes, 0).dispose).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.isLive()).toBe(false);
    expect(outcomes).toEqual(['ok']);
  });

  it('As a dApp user who asks for the core while it redials, I get the new core once it is up', async () => {
    // Given
    const { core, runtimes, requests, outcomes, nextBoots, changes } = harness();
    const lease = await core.acquire();
    await lease.connect();
    const redial = heldBoot(changes);
    nextBoots.push(redial.boot);
    nthRuntime(runtimes, 0).providers[0]?.goDown();

    // When
    const next = core.acquire();
    const bootingWhileWaiting = outcomes.length < requests.length;
    const redialed = redial.resolve();

    // Then
    expect(bootingWhileWaiting).toBe(true);
    await expect(next).resolves.toMatchObject({ runtime: redialed.runtime });
  });

  it('As a dApp user whose first redial fails, I see the page try again and the core come back ready', async () => {
    // Given
    const { core, runtimes, requests, outcomes, nextBoots, changes } = harness();
    const lease = await core.acquire();
    await lease.connect();
    nextBoots.push(failingBoot());

    // When
    nthRuntime(runtimes, 0).providers[0]?.goDown();

    // Then
    await changes.until(() => outcomes.length === 3 && outcomes.at(-1) === 'ok');
    expect(requests).toHaveLength(3);
  });

  it('As a dApp user whose redials all fail, my next request dials afresh', async () => {
    // Given
    const { core, runtimes, requests, outcomes, nextBoots, counted, changes } = reportingHarness();
    const lease = await core.acquire();
    await lease.connect();
    nextBoots.push(failingBoot(), failingBoot(), failingBoot());

    // When
    nthRuntime(runtimes, 0).providers[0]?.goDown();
    await changes.until(() => outcomes.length === 4 && outcomes.at(-1) === 'error');
    // The page core takes the core out of service as it reports the redial that gave up, after the boot settled.
    await changes.until(() => counted('wallet.core_redial').length === 1);
    await core.acquire();

    // Then
    expect(requests).toHaveLength(5);
    expect(outcomes.at(-1)).toBe('ok');
  });

  it('As a product whose replacement core cannot boot, the failure is reported once, as the redial', async () => {
    // Given
    const { core, runtimes, nextBoots, captures, changes } = reportingHarness();
    const lease = await core.acquire();
    await lease.connect();
    nextBoots.push(failingBoot(), failingBoot(), failingBoot());

    // When
    nthRuntime(runtimes, 0).providers[0]?.goDown();
    const asked = core.acquire();

    // Then
    const error: unknown = await asked.catch((rejected: unknown) => rejected);
    expect(error).toBeInstanceOf(CoreRedialError);
    expect(error).toMatchObject({ name: 'CoreRedialError', cause: { message: 'worker failed to start' } });
    await changes.until(() => captures.exception.mock.calls.length === 1);
    expect(captures.exception).toHaveBeenCalledTimes(1);
  });

  it('As a user who opened another product before the old core went down, I get a redial for the product on screen', async () => {
    // Given
    const { core, runtimes, requests } = harness();
    const lease = await core.acquire();
    await lease.connect();
    core.setProduct({ label: 'doom' });

    // When
    nthRuntime(runtimes, 0).providers[0]?.goDown();

    // Then
    expect(requests.map(request => request.product.label)).toEqual(['dotli', 'doom']);
  });

  it('As a user, I open another product while the old core redials and the old redial is dropped', async () => {
    // Given
    const { core, runtimes, requests, nextBoots, changes } = harness();
    const lease = await core.acquire();
    await lease.connect();
    const redial = heldBoot(changes);
    nextBoots.push(redial.boot);
    nthRuntime(runtimes, 0).providers[0]?.goDown();
    core.setProduct({ label: 'other' });
    await core.acquire();

    // When
    const late = redial.resolve();

    // Then
    await changes.until(() => late.dispose.mock.calls.length === 1);
    expect(requests[1]?.isLive()).toBe(false);
    expect(requests[2]?.product.label).toBe('other');
    expect((await core.acquire()).runtime).toBe(nthRuntime(runtimes, 1).runtime);
    expect(requests).toHaveLength(3);
  });

  it('As a user, I open another product while the old core redials and the redial goes as soon as the page names it', async () => {
    // Given
    const { core, runtimes, requests, nextBoots, changes } = harness();
    const lease = await core.acquire();
    await lease.connect();
    const redial = heldBoot(changes);
    nextBoots.push(redial.boot);
    nthRuntime(runtimes, 0).providers[0]?.goDown();

    // When
    core.setProduct({ label: 'other' });

    // Then
    expect(requests[1]?.isLive()).toBe(false);
    const late = redial.resolve();
    await changes.until(() => late.dispose.mock.calls.length === 1);
  });

  it('As a dApp user, I see my page name the same product again and the redial goes on', async () => {
    // Given
    const { core, runtimes, requests, nextBoots, changes } = harness();
    const lease = await core.acquire();
    await lease.connect();
    const redial = heldBoot(changes);
    nextBoots.push(redial.boot);
    nthRuntime(runtimes, 0).providers[0]?.goDown();

    // When
    core.setProduct({ label: 'dotli' });
    const replacement = redial.resolve();

    // Then
    expect((await core.acquire()).runtime).toBe(replacement.runtime);
    expect(requests[1]?.isLive()).toBe(true);
    expect(replacement.dispose).not.toHaveBeenCalled();
  });

  it('As a dApp user whose core refuses one connection and closes another, I get one new core dialed', async () => {
    // Given
    const { core, runtimes, requests, outcomes, changes } = harness();
    const lease = await core.acquire();
    await lease.connect();
    nthRuntime(runtimes, 0).createProvider.mockRejectedValueOnce(new Error('runtime disposed'));
    await expect(lease.connect()).rejects.toThrow('runtime disposed');

    // When
    nthRuntime(runtimes, 0).providers[0]?.goDown();

    // Then
    await changes.until(() => outcomes.length === 2 && outcomes.at(-1) === 'ok');
    expect(requests).toHaveLength(2);
  });

  it.each([
    ['in the same turn', 0],
    ['one microtask later', 1],
  ])(
    'As a user, I open another product %s as the old core redial boots and its runtime is disposed once with nothing following it',
    async (_when, microtasks) => {
      // Given
      const { core, runtimes, nextBoots, storeListeners, changes } = harness();
      const lease = await core.acquire();
      await lease.connect();
      const redial = heldBoot(changes);
      nextBoots.push(redial.boot);
      nthRuntime(runtimes, 0).providers[0]?.goDown();
      const late = redial.resolve();

      // When
      for (let tick = 0; tick < microtasks; tick++) {
        await Promise.resolve();
      }
      core.setProduct({ label: 'other' });
      await core.acquire();

      // Then
      await changes.until(() => late.dispose.mock.calls.length === 1);
      await changes.until(() => storeListeners.size === 2);
      expect(late.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it('As a user who logs in on the landing page, my core pairs as Polkadot Web and the product later gets its own', async () => {
    // Given
    const { core, runtimes, requests } = harness();
    await core.acquire();

    // When
    core.setProduct({ label: 'doom' });
    const lease = await core.acquire();
    await lease.connect('Worker');

    // Then
    expect(requests.map(request => request.product.label)).toEqual(['dotli', 'doom']);
    expect(requests[0]?.product.pairing?.label).toBe('Polkadot Web');
    expect(nthRuntime(runtimes, 1).createProvider).toHaveBeenCalledWith({
      productId: labelToProductId('doom'),
      executionKind: 'Worker',
    });
  });

  it('As a Polkadot App user, I log in from another tab and the login reaches my core until its last lease goes', async () => {
    // Given
    const { core, runtimes, storeListeners, changes } = harness();
    const lease = await core.acquire();
    const runtime = nthRuntime(runtimes, 0);
    await changes.until(() => runtime.notifySessionStoreChanged.mock.calls.length === 1);

    // When
    for (const listener of storeListeners) {
      listener();
    }
    lease.release();

    // Then
    expect(runtime.notifySessionStoreChanged).toHaveBeenCalledTimes(2);
    expect(storeListeners.size).toBe(0);
  });

  it('As a local wallet user, my core follows no stored session', async () => {
    // Given
    const { core, storeListeners } = harness({ local: true });

    // When
    await core.acquire();

    // Then
    expect(storeListeners.size).toBe(0);
  });

  it('As a Polkadot App user, I close the login modal and my core cancels the pairing', async () => {
    // Given
    const { core, runtimes, changes } = harness();
    await core.acquire();

    // When
    core.cancelPairing();

    // Then
    await changes.until(() => nthRuntime(runtimes, 0).cancelPairing.mock.calls.length === 1);
  });

  it('As a local wallet user, I close the login modal and my core never receives a pairing cancel', async () => {
    // Given
    const { core, runtimes } = harness({ local: true });
    const lease = core.acquire();
    await lease;

    // When
    core.cancelPairing();
    // The cancel reads the booted runtime, which settled before this wait.
    await lease;

    // Then
    expect(nthRuntime(runtimes, 0).cancelPairing).not.toHaveBeenCalled();
  });
});

describe('page core redial reports', () => {
  it('As an operator, I see a redial that brought the core back counted as ok with what made the core go down', async () => {
    // Given
    const { core, runtimes, outcomes, counted, changes } = reportingHarness();
    const lease = await core.acquire();
    await lease.connect();

    // When
    nthRuntime(runtimes, 0).providers[0]?.goDown();
    await changes.until(() => counted('wallet.core_redial').length === 1);

    // Then
    expect(outcomes).toEqual(['ok', 'ok']);
    expect(counted('wallet.core_redial')).toEqual([{ outcome: 'ok', reason: 'closed' }]);
  });

  it('As an operator, I see a redial that gave up captured and counted as an error', async () => {
    // Given
    const { core, runtimes, outcomes, nextBoots, counted, captures, changes } = reportingHarness();
    const lease = await core.acquire();
    const failure = new Error('worker failed to start');
    nextBoots.push(
      () => Promise.reject(failure),
      () => Promise.reject(failure),
      () => Promise.reject(failure),
    );
    nthRuntime(runtimes, 0).createProvider.mockRejectedValueOnce(new Error('runtime disposed'));

    // When
    await expect(lease.connect()).rejects.toThrow('runtime disposed');
    await changes.until(() => counted('wallet.core_redial').length === 1);

    // Then
    expect(outcomes).toEqual(['ok', 'error', 'error', 'error']);
    expect(captures.exception).toHaveBeenCalledWith(failure, {
      flow: 'wallet',
      step: 'core_redial',
      tags: { reason: 'refused' },
    });
    expect(counted('wallet.core_redial')).toEqual([{ outcome: 'error', reason: 'refused' }]);
  });

  it.each([0, 1, 2])(
    'As an operator, I see a redial dropped %i microtasks after its boot counted as aborted, never ok',
    async microtasks => {
      // Given
      const { core, runtimes, nextBoots, counted, storeListeners, changes } = reportingHarness();
      const lease = await core.acquire();
      await lease.connect();
      const redial = heldBoot(changes);
      nextBoots.push(redial.boot);
      nthRuntime(runtimes, 0).providers[0]?.goDown();
      redial.resolve();

      // When
      for (let tick = 0; tick < microtasks; tick++) {
        await Promise.resolve();
      }
      core.setProduct({ label: 'other' });
      await core.acquire();

      // Then
      await changes.until(() => counted('wallet.core_redial').length === 1);
      expect(counted('wallet.core_redial')).toEqual([{ outcome: 'aborted', reason: 'closed' }]);
      // The leased old core and the new one, and nothing for the dropped redial.
      await changes.until(() => storeListeners.size === 2);
    },
  );

  it('As an operator, I see a pairing core retired for a wallet found after its boot counted with reason stale', async () => {
    // Given
    let walletFound = false;
    const { core, counted, changes } = reportingHarness({ walletFound: () => walletFound });
    const booting = core.acquire();

    // When
    walletFound = true;
    await booting;

    // Then
    await changes.until(() => counted('wallet.core_redial').length === 1);
    expect(counted('wallet.core_redial')).toEqual([{ outcome: 'ok', reason: 'stale' }]);
  });

  it('As an operator, I see a redial that a product change dropped counted as aborted', async () => {
    // Given
    const { core, runtimes, nextBoots, counted, changes } = reportingHarness();
    const lease = await core.acquire();
    await lease.connect();
    const redial = heldBoot(changes);
    nextBoots.push(redial.boot);
    nthRuntime(runtimes, 0).providers[0]?.goDown();

    // When
    core.setProduct({ label: 'other' });
    await core.acquire();

    // Then
    await changes.until(() => counted('wallet.core_redial').length === 1);
    expect(counted('wallet.core_redial')).toEqual([{ outcome: 'aborted', reason: 'closed' }]);
  });
});

describe('page core after a failed wallet read', () => {
  it('As a local wallet user whose wallet read failed at boot, my pairing core is retired once the store is back and the wallet is found', async () => {
    // Given
    let walletFound = false;
    const { core, runtimes, requests, storeListeners, changes } = harness({ walletFound: () => walletFound });
    const lease = await core.acquire();
    await lease.connect();
    const pairing = nthRuntime(runtimes, 0);

    // When
    walletFound = true;
    for (const listener of [...storeListeners]) {
      listener();
    }

    // Then
    await changes.until(() => requests.length === 2);
    expect(pairing.notifySessionStoreChanged).toHaveBeenCalled();
    const next = await core.acquire();
    expect(next.runtime).toBe(nthRuntime(runtimes, 1).runtime);
  });

  it('As a local wallet user whose store came back while my pairing core booted, I am moved to my local core', async () => {
    // Given: a pairing core booting on a wallet read that failed
    let walletFound = false;
    const { core, runtimes, requests, storeListeners, changes } = harness({ walletFound: () => walletFound });
    const booting = core.acquire();

    // When: the store comes back before the core follows it, so no store event reaches the core
    walletFound = true;
    const lease = await booting;

    // Then
    expect(lease.runtime).toBe(nthRuntime(runtimes, 0).runtime);
    await changes.until(() => requests.length === 2);
    const next = await core.acquire();
    expect(next.runtime).toBe(nthRuntime(runtimes, 1).runtime);
    expect(storeListeners.size).toBe(1);
  });

  it('As a local wallet user whose store came back, I get one local core for two store events', async () => {
    // Given
    let walletFound = false;
    const { core, requests, storeListeners, staleChecks, outcomes, changes } = harness({
      walletFound: () => walletFound,
    });
    await core.acquire();

    // When
    walletFound = true;
    for (const listener of [...storeListeners]) {
      listener();
      listener();
    }
    await Promise.all(staleChecks);

    // Then
    await changes.until(() => outcomes.length === 2 && outcomes.at(-1) === 'ok');
    expect(requests).toHaveLength(2);
    expect(outcomes).toEqual(['ok', 'ok']);
  });

  it('As a Polkadot App user, I see a stored session change and keep my core', async () => {
    // Given
    const { core, requests, storeListeners, outcomes, staleChecks } = harness({ walletFound: () => false });
    const lease = await core.acquire();

    // When
    for (const listener of [...storeListeners]) {
      listener();
    }
    await Promise.all(staleChecks);
    const next = await core.acquire();

    // Then: one check as the core first follows the store, and one for the change
    expect(staleChecks).toHaveLength(2);
    expect(next.runtime).toBe(lease.runtime);
    expect(requests).toHaveLength(1);
    expect(outcomes).toEqual(['ok']);
  });
});

describe('page core retirement', () => {
  it('As a dApp user whose core went down, I keep it under my product while it stops speaking for my session', async () => {
    // Given
    const { core, runtimes, requests, outcomes, changes } = harness();
    const lease = await core.acquire();
    await lease.connect();

    // When
    nthRuntime(runtimes, 0).providers[0]?.goDown();

    // Then
    expect(requests[0]?.isLive()).toBe(true);
    expect(requests[0]?.inService()).toBe(false);
    await changes.until(() => outcomes.length === 2 && outcomes.at(-1) === 'ok');
    expect(requests[1]?.inService()).toBe(true);
  });

  it('As a local wallet user whose pairing core turned stale, I keep it under my product while it stops speaking for my session', async () => {
    // Given
    let walletFound = false;
    const { core, requests, storeListeners, changes } = harness({ walletFound: () => walletFound });
    const lease = await core.acquire();
    await lease.connect();
    expect(requests[0]?.inService()).toBe(true);

    // When
    walletFound = true;
    for (const listener of [...storeListeners]) {
      listener();
    }

    // Then
    await changes.until(() => requests.length === 2);
    expect(requests[0]?.isLive()).toBe(true);
    expect(requests[0]?.inService()).toBe(false);
  });

  it('As a user, I open another product while a login still holds the old core and it speaks for my session until it goes down', async () => {
    // Given a core a product change replaced while its lease is still held
    const { core, runtimes, requests, outcomes } = harness();
    core.setProduct({ label: 'first' });
    const kept = await core.acquire();
    await kept.connect();
    core.setProduct({ label: 'second' });
    await core.acquire();
    expect(requests[0]?.inService()).toBe(true);

    // When the old core goes down
    nthRuntime(runtimes, 0).providers[0]?.goDown();

    // Then it stops speaking for the session, and the page dials nothing for the product it left
    expect(requests[0]?.isLive()).toBe(true);
    expect(requests[0]?.inService()).toBe(false);
    expect(requests[1]?.inService()).toBe(true);
    expect(requests).toHaveLength(2);
    expect(outcomes).toEqual(['ok', 'ok']);
  });
});

describe('page core with nobody holding it', () => {
  /** A replacement core nobody took a lease on, since its only holder released the core that went down. */
  async function unheldReplacement(): Promise<
    ReturnType<typeof reportingHarness> & { setWalletFound: (found: boolean) => void }
  > {
    let walletFound = false;
    const fakes = reportingHarness({ walletFound: () => walletFound });
    const lease = await fakes.core.acquire();
    await lease.connect();
    nthRuntime(fakes.runtimes, 0).providers[0]?.goDown();
    await fakes.changes.until(() => fakes.outcomes.length === 2);
    lease.release();
    // The replacement follows the store, and checks itself, once as it boots.
    await fakes.changes.until(() => nthRuntime(fakes.runtimes, 1).notifySessionStoreChanged.mock.calls.length === 1);
    return {
      ...fakes,
      setWalletFound: found => {
        walletFound = found;
      },
    };
  }

  it('As a page whose unheld core dies, no replacement is booted until someone asks for one', async () => {
    // Given
    const { runtimes, requests, storeListeners, staleChecks, counted, changes, setWalletFound } =
      await unheldReplacement();

    // When the replacement turns stale, as another tab logs in with the local wallet
    setWalletFound(true);
    for (const listener of [...storeListeners]) {
      listener();
    }
    await Promise.all(staleChecks);

    // Then it goes, and nothing is booted in its place
    await changes.until(() => nthRuntime(runtimes, 1).dispose.mock.calls.length === 1);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.isLive()).toBe(false);
    expect(storeListeners.size).toBe(0);
    expect(counted('wallet.core_redial')).toEqual([{ outcome: 'ok', reason: 'closed' }]);
  });

  it('As a sign-in after the unheld core died, I get a fresh core', async () => {
    // Given an unheld replacement that turned stale and went
    const { core, runtimes, requests, storeListeners, staleChecks, changes, setWalletFound } =
      await unheldReplacement();
    setWalletFound(true);
    for (const listener of [...storeListeners]) {
      listener();
    }
    await Promise.all(staleChecks);
    await changes.until(() => nthRuntime(runtimes, 1).dispose.mock.calls.length === 1);

    // When
    const lease = await core.acquire();

    // Then
    expect(requests).toHaveLength(3);
    expect(lease.runtime).toBe(nthRuntime(runtimes, 2).runtime);
    expect(requests[2]?.inService()).toBe(true);
  });

  it('As a product holding the core when it dies, I get a replacement at once', async () => {
    // Given a product that took the unheld replacement and connected on it
    const { core, runtimes, requests, outcomes, changes } = await unheldReplacement();
    const lease = await core.acquire();
    await lease.connect();
    const heard: number[] = [];
    lease.subscribeDown(() => {
      heard.push(requests.length);
    });

    // When
    nthRuntime(runtimes, 1).providers[0]?.goDown();

    // Then
    expect(heard).toEqual([3]);
    await changes.until(() => outcomes.length === 3 && outcomes.at(-1) === 'ok');
    expect((await core.acquire()).runtime).toBe(nthRuntime(runtimes, 2).runtime);
  });
});
