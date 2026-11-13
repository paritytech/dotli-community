// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { asProductId } from '@parity/truapi';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { TrUApiProductProvider } from '@parity/truapi-host';
import type { WorkerPairingHostRuntime } from '@parity/truapi-host/web';
import { createAsyncTaskPool, createDeferred, type Timers } from '@dotli/shared';
import { createManualTimers, nth, recordLog } from '@dotli/shared/testing';
import { createBlockingModalCoordinator } from './createBlockingModalCoordinator.js';
import type { BootCoreRuntime, BootedCoreRuntime } from './createCoreRuntimeBoot.js';
import { CoreRedialError } from './coreRedialError.js';
import { createPageCore, type CoreContext } from './createPageCore.js';
import { toProductId } from './createTruapiRuntimeConfig.js';
import { encodeGarbagePhoneRequestFrame } from '../testing/encodeGarbagePhoneRequestFrame.js';
import { encodePhoneRequestFrame } from '../testing/encodePhoneRequestFrame.js';
import { encodePhoneResponseFrame } from '../testing/encodePhoneResponseFrame.js';
import { createPhoneRequestTracker, type PhoneRequestTracker } from './createPhoneRequestTracker.js';
import { bindReports } from '../testing/bindReports.js';
import { createChanges, type Changes } from '../testing/changes.js';
import { bindRecordingSentry } from '@dotli/metrics/testing';

type FakeProvider = ReturnType<typeof createFakeProvider>;

type FakeRuntime = ReturnType<typeof createFakeRuntime>;

type CreateHarnessParams = {
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
};

type CreateRecordingTrackerParams = {
  /** Whether each tap throws once it has recorded its frame. */
  broken?: boolean;
};

type CreateFakeProviderParams = {
  /** Notified at the connection's dispose. */
  changes: Changes;
};

type CreateFakeRuntimeParams = {
  /** Notified at each call on the runtime or on a connection it opened. */
  changes: Changes;
};

type CreateHeldBootParams = {
  /** Notified at each call on the runtime the boot answers with. */
  changes: Changes;
};

/** A V1 `signRaw` request body of the product's first account. */
const SIGN_RAW_BODY = {
  account: { dotNsIdentifier: asProductId('product.dot'), derivationIndex: { tag: 'Index', value: 0 } },
  payload: { tag: 'Payload', value: { payload: 'x' } },
};

function createFakeProvider({ changes }: CreateFakeProviderParams) {
  const listeners = new Set<(error: Error) => void>();
  const posted: Uint8Array[] = [];
  const subscribers = new Set<(message: Uint8Array) => void>();

  function closeAll(error: Error): void {
    for (const listener of [...listeners]) {
      listener(error);
    }
  }

  // A deliberate dispose fires close listeners too, as the real provider does.
  const dispose = vi.fn(() => {
    closeAll(new Error('disposed'));
    changes.notify();
  });
  // The fake has the wire members the page core uses, not the full provider interface.
  const provider = {
    postMessage(message: Uint8Array): void {
      posted.push(message);
    },
    subscribe(listener: (message: Uint8Array) => void) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    subscribeClose(listener: (error: Error) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose,
  } as unknown as TrUApiProductProvider;
  return {
    /** The connection the page core gets. */
    provider,
    /** The connection's dispose. */
    dispose,
    /** Every frame posted to the core, in order. */
    posted,
    /** The core sending a frame to its subscribers. */
    send(message: Uint8Array): void {
      for (const subscriber of [...subscribers]) {
        subscriber(message);
      }
    },
    /** The core going down under the connection. */
    goDown(): void {
      closeAll(new Error('worker gone'));
    },
  };
}

function createFakeRuntime({ changes }: CreateFakeRuntimeParams) {
  const providers: FakeProvider[] = [];
  const createProvider = vi.fn<WorkerPairingHostRuntime['createProvider']>(() => {
    const provider = createFakeProvider({ changes });
    providers.push(provider);
    changes.notify();
    return Promise.resolve(provider.provider);
  });
  const cancelPairing = vi.fn<() => void>(changes.notify);
  const notifySessionStoreChanged = vi.fn<() => void>(changes.notify);
  const resetSessionState = vi.fn(() => {
    changes.notify();
    return Promise.resolve();
  });
  const dispose = vi.fn<() => void>(changes.notify);
  // The fake has the members the page core calls, not the full runtime interface.
  const runtime = {
    createProvider,
    cancelPairing,
    notifySessionStoreChanged,
    resetSessionState,
    dispose,
  } as unknown as WorkerPairingHostRuntime;
  return {
    /** The runtime a boot answers with. */
    runtime,
    /** Opens a fake connection, kept in `providers`. */
    createProvider,
    /** Records a pairing cancel. */
    cancelPairing,
    /** Records a stored session change told to the core. */
    notifySessionStoreChanged,
    /** Records a session reset. */
    resetSessionState,
    /** Records the runtime's dispose. */
    dispose,
    /** Every connection the runtime opened, in order. */
    providers,
  };
}

function createHarness({
  local: fixedLocal,
  createPhoneRequests,
  walletFound,
  onCoresGone,
  destroyDelay = 0,
  timers,
}: CreateHarnessParams = {}) {
  const runtimes: FakeRuntime[] = [];
  const contexts: CoreContext[] = [];
  const nextBoots: BootCoreRuntime[] = [];
  const storeListeners = new Set<() => void>();
  const staleChecks: Promise<boolean>[] = [];
  const outcomes: ('ok' | 'error')[] = [];
  const changes = createChanges();

  function bootNow({ product }: CoreContext): Promise<BootedCoreRuntime> {
    const runtime = createFakeRuntime({ changes });
    runtimes.push(runtime);
    // As the real boot does, a wallet read that finds the wallet boots a local core, which is never stale.
    const local = fixedLocal ?? walletFound?.() ?? false;
    return Promise.resolve({
      runtime: runtime.runtime,
      productId: asProductId(product.productId ?? toProductId(product.label)),
      local,
      isStale() {
        const check = local ? Promise.resolve(false) : Promise.resolve().then(() => walletFound?.() ?? false);
        staleChecks.push(check);
        return check;
      },
    });
  }

  const core = createPageCore({
    bootRuntime(context) {
      contexts.push(context);
      changes.notify();
      const attempt = (nextBoots.shift() ?? bootNow)(context);
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
    subscribeStoredSession(listener) {
      storeListeners.add(listener);
      changes.notify();
      return () => {
        storeListeners.delete(listener);
        changes.notify();
      };
    },
    coordinator: createBlockingModalCoordinator(),
    redials: createAsyncTaskPool({ poolSize: 1, retryCount: 2 }),
    destroyDelay,
    ...(timers === undefined ? {} : { timers }),
    ...(createPhoneRequests === undefined ? {} : { createPhoneRequests }),
    ...(onCoresGone === undefined ? {} : { onCoresGone }),
  });
  return {
    /** The page core under test. */
    core,
    /** Every runtime a boot attempt produced, in order. */
    runtimes,
    /** Every boot context, in order. */
    contexts,
    /** How each boot attempt settled, in order, recorded before the page core handles it. */
    outcomes,
    /** The page core's stored session listeners. */
    storeListeners,
    /** Queues how the next boot attempts end. An attempt with nothing queued boots at once. */
    nextBoots,
    /** Every stale check the page core made, in order. */
    staleChecks,
    /** Notified at each boot context and outcome, store listener change and call on a fake runtime or connection. */
    changes,
  };
}

function createFailingBoot(): BootCoreRuntime {
  return () => Promise.reject(new Error('worker failed to start'));
}

/** A boot that waits until the test lets it through with a fresh pairing runtime. */
function createHeldBoot({ changes }: CreateHeldBootParams) {
  const pending = createDeferred<BootedCoreRuntime>();
  return {
    /** The boot to queue. */
    boot: (): Promise<BootedCoreRuntime> => pending.promise,
    /** Lets the boot through and returns its runtime. */
    resolve(): FakeRuntime {
      const runtime = createFakeRuntime({ changes });
      pending.resolve({
        runtime: runtime.runtime,
        productId: asProductId('held.dot'),
        local: false,
        isStale: () => Promise.resolve(false),
      });
      return runtime;
    },
  };
}

/** A harness with a fake Sentry and capture sink bound for this test. */
function createReportingHarness(params: CreateHarnessParams = {}) {
  const fakes = createHarness(params);
  const { captures, counted } = bindReports({ onReport: fakes.changes.notify });
  return {
    ...fakes,
    /** The outcomes counted under a metric name. */
    counted,
    /** The capture sink's exception and expected-failure spies. */
    captures,
  };
}

/** A real tracker whose taps record every frame they are told of first, and then throw if `broken`. */
function createRecordingTracker({ broken = false }: CreateRecordingTrackerParams = {}) {
  const real = createPhoneRequestTracker();
  const fromProduct: Uint8Array[] = [];
  const fromCore: Uint8Array[] = [];

  function recordFrames(frames: Uint8Array[], next: (message: Uint8Array) => void): (message: Uint8Array) => void {
    function tap(message: Uint8Array): void {
      frames.push(message);
      if (broken) {
        throw new Error('tap broke');
      }
      next(message);
    }
    return tap;
  }

  const tracker: PhoneRequestTracker = {
    ...real,
    connect() {
      const tap = real.connect();
      return {
        ...tap,
        fromProduct: recordFrames(fromProduct, tap.fromProduct),
        fromCore: recordFrames(fromCore, tap.fromCore),
      };
    },
  };
  return {
    /** The tracker to give the page core. */
    tracker,
    /** Every frame from the product, in order. */
    fromProduct,
    /** Every frame from the core, in order. */
    fromCore,
  };
}

function getTracker(context: CoreContext | undefined): PhoneRequestTracker {
  if (context === undefined) {
    throw new Error('no core was requested');
  }
  return context.phoneRequests;
}

describe('page core', () => {
  it('As a user signed out in another tab, I reset the session and the core my product holds drops it', async () => {
    // Given a page core already running
    const { core, runtimes } = createHarness();
    await core.acquire();

    // When the session is reset
    await core.resetSession();

    // Then the running core reset its session state
    expect(nth(runtimes, 0).resetSessionState).toHaveBeenCalledTimes(1);
  });

  it('As a user signed out in another tab with no core running, I reset the session and no core boots to drop one', async () => {
    // Given a page core that never booted
    const { core, contexts } = createHarness();

    // When the session is reset
    await core.resetSession();

    // Then no core was booted
    expect(contexts).toHaveLength(0);
  });

  it('As a user signed out in another tab while my core is still booting, I reset the session and a boot that fails leaves nothing to drop', async () => {
    // Given: a core whose boot is in flight
    const { core, nextBoots } = createHarness();
    const boot = createDeferred<BootedCoreRuntime>();
    nextBoots.push(() => boot.promise);
    const lease = core.acquire();

    // When the session is reset and the boot then fails
    const reset = core.resetSession();
    boot.reject(new Error('worker failed to start'));

    // Then the lease fails with the boot and the reset settles
    await expect(lease).rejects.toThrow('worker failed to start');
    await expect(reset).resolves.toBeUndefined();
  });

  it('As a dotli integrator, I release my last lease and take a new one within the destroy delay and keep the same core', async () => {
    // Given a core whose only lease was released
    const timers = createManualTimers();
    const { core, contexts, runtimes } = createHarness({ destroyDelay: 5000, timers });
    const first = await core.acquire();
    first.release();

    // When the delay has almost run out and a new lease is taken
    await timers.advance(4999);
    await core.acquire();

    // Then the same core serves it, nothing was disposed and no timer is left
    expect(contexts).toHaveLength(1);
    expect(nth(runtimes, 0).dispose).not.toHaveBeenCalled();
    expect(timers.countPending()).toBe(0);
  });

  it('As a dotli integrator, I release my last lease and the core goes once the destroy delay ends', async () => {
    // Given a core whose only lease was released
    const timers = createManualTimers();
    const onCoresGone = vi.fn();
    const { core, runtimes } = createHarness({ destroyDelay: 5000, timers, onCoresGone });
    const lease = await core.acquire();
    lease.release();

    // When the destroy delay ends
    await timers.advance(5000);

    // Then the core is disposed once and the page hears its last core go
    expect(nth(runtimes, 0).dispose).toHaveBeenCalledTimes(1);
    expect(onCoresGone).toHaveBeenCalledTimes(1);
  });

  it('As a dotli integrator, I release my last lease and a lingering core whose connection closes goes at once', async () => {
    // Given a lingering core that has a connection
    const timers = createManualTimers();
    const { core, runtimes } = createHarness({ destroyDelay: 5000, timers });
    const lease = await core.acquire();
    await lease.connect();
    lease.release();
    const lingering = { disposed: nth(runtimes, 0).dispose.mock.calls.length, pending: timers.countPending() };
    const provider = nth(nth(runtimes, 0).providers, 0);

    // When its connection closes
    provider.goDown();

    // Then it lingered until then, and is disposed at once with its timer cleared
    expect(lingering).toEqual({ disposed: 0, pending: 1 });
    expect(nth(runtimes, 0).dispose).toHaveBeenCalledTimes(1);
    expect(timers.countPending()).toBe(0);
  });

  it('As a user, I change product and see a lingering core go at once', async () => {
    // Given a lingering core
    const timers = createManualTimers();
    const { core, runtimes } = createHarness({ destroyDelay: 5000, timers });
    const lease = await core.acquire();
    lease.release();
    const lingering = { disposed: nth(runtimes, 0).dispose.mock.calls.length, pending: timers.countPending() };

    // When the page names another product
    core.setProduct({ label: 'other' });

    // Then it lingered until then, and is disposed at once with its timer cleared
    expect(lingering).toEqual({ disposed: 0, pending: 1 });
    expect(nth(runtimes, 0).dispose).toHaveBeenCalledTimes(1);
    expect(timers.countPending()).toBe(0);
  });

  it('As a user who changed product while a login held the old core, I end the login and the old core goes at once', async () => {
    // Given a core held by a login while the page moves to another product
    const timers = createManualTimers();
    const { core, runtimes } = createHarness({ destroyDelay: 5000, timers });
    const lease = await core.acquire();
    core.setProduct({ label: 'other' });

    // When the login releases it
    lease.release();

    // Then the old core is disposed at once, with no timer
    expect(nth(runtimes, 0).dispose).toHaveBeenCalledTimes(1);
    expect(timers.countPending()).toBe(0);
  });

  it('As a user signed out in another tab, I reset the session and my lingering core drops it', async () => {
    // Given a lingering core
    const timers = createManualTimers();
    const { core, runtimes } = createHarness({ destroyDelay: 5000, timers });
    const lease = await core.acquire();
    lease.release();

    // When the session is reset
    await core.resetSession();

    // Then the core dropped its session and was not disposed
    expect(nth(runtimes, 0).resetSessionState).toHaveBeenCalledTimes(1);
    expect(nth(runtimes, 0).dispose).not.toHaveBeenCalled();
  });

  it("As a dApp user, I send and receive frames and they pass the connection unchanged while my core's tracker hears each one", async () => {
    // Given a connection on a core whose tracker records its frames
    const recording = createRecordingTracker();
    const { core, runtimes } = createHarness({ createPhoneRequests: () => recording.tracker });
    const lease = await core.acquire();
    const connection = await lease.connect();
    const toProduct: Uint8Array[] = [];
    connection.provider.subscribe(message => toProduct.push(message));
    const request = encodePhoneRequestFrame({ requestId: 'r1', method: 'signRaw', body: SIGN_RAW_BODY });
    const response = encodePhoneResponseFrame({
      requestId: 'r1',
      method: 'signRaw',
      result: { kind: 'ok', value: { signature: '0x01' } },
    });

    // When the product sends a request and the core answers
    connection.provider.postMessage(request);
    nth(runtimes, 0).providers[0]?.send(response);

    // Then both pass unchanged and the tracker heard each
    expect(nth(runtimes, 0).providers[0]?.posted).toEqual([request]);
    expect(toProduct).toEqual([response]);
    expect(recording.fromProduct).toEqual([request]);
    expect(recording.fromCore).toEqual([response]);
  });

  it("As a dApp user, I close my connection and my request claimed from my core's tracker ends as gone", async () => {
    // Given a request claimed from the core's tracker
    const { core, contexts } = createHarness();
    const lease = await core.acquire();
    const connection = await lease.connect();
    connection.provider.postMessage(
      encodePhoneRequestFrame({ requestId: 'r1', method: 'signRaw', body: SIGN_RAW_BODY }),
    );
    const claim = getTracker(contexts[0]).claim(() => true);

    // When the connection closes
    connection.close();

    // Then the claim was the request and ends as gone
    expect(claim?.request.method).toBe('signRaw');
    await expect(claim?.ended).resolves.toEqual({ kind: 'gone' });
  });

  it('As a dApp user, I send and receive frames over a tap that throws and they still pass both ways while the throw is reported', async () => {
    // Given a connection on a core whose tracker taps throw
    const recording = createRecordingTracker({ broken: true });
    const { core, runtimes, captures } = createReportingHarness({ createPhoneRequests: () => recording.tracker });
    recordLog({ onFinished: onTestFinished, level: 'error' });
    const lease = await core.acquire();
    const connection = await lease.connect();
    const toProduct: Uint8Array[] = [];
    connection.provider.subscribe(message => toProduct.push(message));
    const request = encodePhoneRequestFrame({ requestId: 'r1', method: 'signRaw', body: SIGN_RAW_BODY });
    const response = encodePhoneResponseFrame({
      requestId: 'r1',
      method: 'signRaw',
      result: { kind: 'ok', value: { signature: '0x01' } },
    });

    // When the product sends a request and the core answers
    connection.provider.postMessage(request);
    nth(runtimes, 0).providers[0]?.send(response);

    // Then both pass unchanged and each throw is reported
    expect(nth(runtimes, 0).providers[0]?.posted).toEqual([request]);
    expect(toProduct).toEqual([response]);
    expect(captures.exception).toHaveBeenCalledTimes(2);
  });

  it('As an operator, I see a phone request tap that throws on a frame captured and counted', async () => {
    // Given a connection on a core whose tracker taps throw
    const recording = createRecordingTracker({ broken: true });
    const { core, captures, counted } = createReportingHarness({ createPhoneRequests: () => recording.tracker });
    recordLog({ onFinished: onTestFinished, level: 'error' });
    const lease = await core.acquire();
    const connection = await lease.connect();

    // When the product sends a request
    connection.provider.postMessage(
      encodePhoneRequestFrame({ requestId: 'r1', method: 'signRaw', body: SIGN_RAW_BODY }),
    );

    // Then the throw is captured once and counted under the product side
    expect(captures.exception.mock.calls).toMatchObject([
      [new Error('tap broke'), { step: 'phone_request_tap', tags: { side: 'product' } }],
    ]);
    expect(counted('signing.phone_request_tap')).toEqual([{ outcome: 'error', reason: 'Error', side: 'product' }]);
  });

  it('As a dApp user whose core is redialed, I get a new tracker and the old one ends its claims as gone', async () => {
    // Given a request in flight on the first core, claimed
    const { core, runtimes, contexts, changes } = createHarness();
    const lease = await core.acquire();
    const connection = await lease.connect();
    connection.provider.postMessage(
      encodePhoneRequestFrame({ requestId: 'r1', method: 'signRaw', body: SIGN_RAW_BODY }),
    );
    const first = getTracker(contexts[0]);
    const claim = first.claim(() => true);

    // When the core goes down and is redialed, and the old core goes with its last lease
    nth(runtimes, 0).providers[0]?.goDown();
    await changes.until(() => contexts.length === 2);
    lease.release();

    // Then the new core has its own tracker and the old claim ends as gone
    expect(getTracker(contexts[1])).not.toBe(first);
    await expect(claim?.ended).resolves.toEqual({ kind: 'gone' });
  });

  it('As a local wallet user, I use a product and none of its requests are tracked', async () => {
    // Given a local wallet core
    const { core, contexts, captures } = createReportingHarness({ local: true });
    const lease = await core.acquire();
    const connection = await lease.connect();

    // When a frame the tracker could not decode, and a sign request, pass the connection
    connection.provider.postMessage(encodeGarbagePhoneRequestFrame('r1', 'signRaw'));
    connection.provider.postMessage(
      encodePhoneRequestFrame({ requestId: 'r2', method: 'signRaw', body: SIGN_RAW_BODY }),
    );

    // Then nothing is reported and nothing can be claimed
    expect(captures.exception).not.toHaveBeenCalled();
    expect(getTracker(contexts[0]).claim(() => true)).toBeUndefined();
  });

  it('As a dApp user, I use one core from two parts of the page and it goes with the last lease', async () => {
    // Given two leases on one core
    const { core, runtimes, contexts, outcomes, changes } = createHarness();
    const first = await core.acquire();
    const second = await core.acquire();

    // When both are released, the first twice
    first.release();
    first.release();
    second.release();
    await changes.until(() => nth(runtimes, 0).dispose.mock.calls.length === 1);

    // Then the one core booted is disposed
    expect(nth(runtimes, 0).dispose).toHaveBeenCalledTimes(1);
    expect(contexts).toHaveLength(1);
    expect(outcomes).toEqual(['ok']);
  });

  it('As a dotli integrator, I release one of two leases on a core and am not told the last core went', async () => {
    // Given two leases on one core
    const onCoresGone = vi.fn();
    const { core } = createHarness({ onCoresGone });
    const first = await core.acquire();
    await core.acquire();

    // When the first goes
    first.release();

    // Then the core still lives
    expect(onCoresGone).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, I release both leases on a core and am told once that the last core went', async () => {
    // Given two leases on one core, the first released
    const onCoresGone = vi.fn();
    const { core } = createHarness({ onCoresGone });
    const first = await core.acquire();
    const second = await core.acquire();
    first.release();

    // When the last goes, twice
    second.release();
    second.release();

    // Then the page heard once that its last core went
    expect(onCoresGone).toHaveBeenCalledTimes(1);
  });

  it('As a dApp user, I close a connection and the core stays ready without being dialed again', async () => {
    // Given a connection on a core
    const { core, contexts } = createHarness();
    const lease = await core.acquire();
    const connection = await lease.connect();

    // When the connection closes
    connection.close();

    // Then the core is still in service and was not dialed again
    expect(contexts[0]?.isInService()).toBe(true);
    expect(contexts).toHaveLength(1);
  });

  it('As a dApp user whose core fails to boot, I ask for it and my request fails with one boot attempted', async () => {
    // Given a boot that fails
    const { core, contexts, outcomes, nextBoots } = createHarness();
    nextBoots.push(createFailingBoot());

    // When the product asks for the core
    const lease = core.acquire();

    // Then the request fails after one boot
    await expect(lease).rejects.toThrow('worker failed to start');
    expect(contexts).toHaveLength(1);
    expect(outcomes).toEqual(['error']);
  });

  it('As a dApp user whose core failed to boot, I ask again and my request dials a new core', async () => {
    // Given a first request whose boot failed
    const { core, contexts, outcomes, nextBoots } = createHarness();
    nextBoots.push(createFailingBoot());
    const firstFailure = await core.acquire().then(
      () => null,
      (error: unknown) => error,
    );

    // When the product asks again
    await core.acquire();

    // Then a second core was dialed
    expect(firstFailure).toBeInstanceOf(Error);
    expect(contexts).toHaveLength(2);
    expect(outcomes).toEqual(['error', 'ok']);
  });

  it('As a dApp user whose core boot throws before it starts, I see my first ask refused and the next one dial again', async () => {
    // Given a first boot that throws before it returns
    const { core, runtimes, contexts, nextBoots } = createHarness();
    nextBoots.push(() => {
      throw new Error('boot threw');
    });

    // When I ask for the core, and ask again once the first ask failed
    const firstFailure = await core.acquire().then(
      () => null,
      (error: unknown) => error,
    );
    const second = await core.acquire();

    // Then the first ask failed with the throw, and the second dialed a second core
    expect(firstFailure).toMatchObject({ message: 'boot threw' });
    expect(contexts).toHaveLength(2);
    expect(second.runtime).toBe(nth(runtimes, 0).runtime);
  });

  it('As a dApp user whose core goes down under my product, I wait and a new core is dialed without asking', async () => {
    // Given a connection on a core
    const { core, runtimes, contexts, outcomes, changes } = createHarness();
    const lease = await core.acquire();
    await lease.connect();

    // When the core goes down, the redial ends and the product asks for the core
    nth(runtimes, 0).providers[0]?.goDown();
    await changes.until(() => outcomes.length === 2 && outcomes.at(-1) === 'ok');
    const contextsBeforeAsk = contexts.length;
    const next = await core.acquire();

    // Then one new core was dialed before the ask, and the ask gets it
    expect(outcomes).toEqual(['ok', 'ok']);
    expect([contextsBeforeAsk, contexts.length]).toEqual([2, 2]);
    expect(next.runtime).toBe(nth(runtimes, 1).runtime);
  });

  it('As a dApp user whose core refuses a connection, I see my request fail and a new core dialed', async () => {
    // Given a core that refuses the next connection
    const { core, runtimes, contexts, outcomes, changes } = createHarness();
    const lease = await core.acquire();
    nth(runtimes, 0).createProvider.mockRejectedValueOnce(new Error('runtime disposed'));

    // When the product connects and the redial ends
    const connection = lease.connect();
    await connection.catch(() => undefined);
    await changes.until(() => outcomes.length === 2 && outcomes.at(-1) === 'ok');

    // Then the connection failed and a second core was dialed
    await expect(connection).rejects.toThrow('runtime disposed');
    expect(contexts).toHaveLength(2);
  });

  it('As a dotli integrator holding a core lease, I listen for its core going down and hear it once, when its replacement is already the one a request gets', async () => {
    // Given a lease with two connections that listens for its core going down
    const { core, runtimes, contexts } = createHarness();
    const lease = await core.acquire();
    await lease.connect();
    await lease.connect();
    const heard: number[] = [];
    lease.subscribeDown(() => {
      heard.push(contexts.length);
    });

    // When both connections close
    for (const provider of nth(runtimes, 0).providers) {
      provider.goDown();
    }

    // Then it heard once, after the replacement was asked for
    expect(heard).toEqual([2]);
  });

  it('As a dotli integrator holding a core lease, I still hear my core go down when a listener before me throws, and the throw is reported', async () => {
    // Given two listeners on one lease, the first throwing
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const { core, runtimes } = createHarness();
    const lease = await core.acquire();
    await lease.connect();
    lease.subscribeDown(() => {
      throw new TypeError('listener broke');
    });
    const heard = vi.fn();
    lease.subscribeDown(heard);

    // When the core goes down
    nth(runtimes, 0).providers[0]?.goDown();

    // Then the second listener heard it and the throw was counted under its owner
    expect(heard).toHaveBeenCalledTimes(1);
    expect(sentry.counted('listener.delivery')).toEqual([
      { outcome: 'error', reason: 'TypeError', owner: 'page_core.down' },
    ]);
  });

  it('As a dotli integrator holding a lease whose core already went down, I subscribe and hear it at once', async () => {
    // Given a lease whose core went down
    const { core, runtimes } = createHarness();
    const lease = await core.acquire();
    await lease.connect();
    nth(runtimes, 0).providers[0]?.goDown();
    const heard = vi.fn();

    // When it subscribes
    lease.subscribeDown(heard);

    // Then it hears the going down at once
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('As a dotli integrator holding a core lease, I release it and do not hear its core go down under a lease still held', async () => {
    // Given two leases on one core, and the first subscribed to its going down
    const { core, runtimes } = createHarness();
    const released = await core.acquire();
    const held = await core.acquire();
    await held.connect();
    const releasedHeard = vi.fn();
    const heldHeard = vi.fn();
    released.subscribeDown(releasedHeard);
    held.subscribeDown(heldHeard);

    // When the first lease goes, then the core goes down under the second
    released.release();
    nth(runtimes, 0).providers[0]?.goDown();

    // Then only the lease still held hears it
    expect(releasedHeard).not.toHaveBeenCalled();
    expect(heldHeard).toHaveBeenCalledTimes(1);
  });

  it('As a dotli integrator holding the last core lease, I release it and nothing reports the core going down after', async () => {
    // Given a connection on a core whose last lease subscribed to its going down
    const { core, runtimes, contexts, outcomes } = createHarness();
    const lease = await core.acquire();
    await lease.connect();
    const heard = vi.fn();
    lease.subscribeDown(heard);

    // When the lease goes, the core's connection closes as its runtime goes with it, and the lease subscribes again
    lease.release();
    nth(runtimes, 0).providers[0]?.goDown();
    const unsubscribe = lease.subscribeDown(heard);

    // Then nobody hears it, no core is dialed again and the runtime is disposed once
    expect(heard).not.toHaveBeenCalled();
    expect(unsubscribe).toBeTypeOf('function');
    expect(nth(runtimes, 0).dispose).toHaveBeenCalledTimes(1);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.isLive()).toBe(false);
    expect(outcomes).toEqual(['ok']);
  });

  it('As a dApp user, I ask for the core while it redials and get the new core once it is up', async () => {
    // Given a core that went down, with its redial held
    const { core, runtimes, contexts, outcomes, nextBoots, changes } = createHarness();
    const lease = await core.acquire();
    await lease.connect();
    const redial = createHeldBoot({ changes });
    nextBoots.push(redial.boot);
    nth(runtimes, 0).providers[0]?.goDown();

    // When the product asks while the redial boots, and the redial is let through
    const next = core.acquire();
    const bootingWhileWaiting = outcomes.length < contexts.length;
    const redialed = redial.resolve();

    // Then the ask waited for the redial and gets its core
    expect(bootingWhileWaiting).toBe(true);
    await expect(next).resolves.toMatchObject({ runtime: redialed.runtime });
  });

  it('As a dApp user whose first redial fails, I see the page try again and the core come back ready', async () => {
    // Given a core whose first redial fails
    const { core, runtimes, contexts, outcomes, nextBoots, changes } = createHarness();
    const lease = await core.acquire();
    await lease.connect();
    nextBoots.push(createFailingBoot());

    // When the core goes down and the redials end
    nth(runtimes, 0).providers[0]?.goDown();
    await changes.until(() => outcomes.length === 3 && outcomes.at(-1) === 'ok');

    // Then a third boot brought it back
    expect(contexts).toHaveLength(3);
  });

  it('As a dApp user whose redials all fail, I ask again and my request dials afresh', async () => {
    // Given a core whose redials all fail
    const { core, runtimes, contexts, outcomes, nextBoots, counted, changes } = createReportingHarness();
    const lease = await core.acquire();
    await lease.connect();
    nextBoots.push(createFailingBoot(), createFailingBoot(), createFailingBoot());

    // When the core goes down, the redials give up, and the product asks again
    nth(runtimes, 0).providers[0]?.goDown();
    await changes.until(() => outcomes.length === 4 && outcomes.at(-1) === 'error');
    // The page core takes the core out of service as it reports the redial that gave up, after the boot settled.
    await changes.until(() => counted('wallet.core_redial').length === 1);
    await core.acquire();

    // Then a fifth boot served the ask
    expect(contexts).toHaveLength(5);
    expect(outcomes.at(-1)).toBe('ok');
  });

  it('As a dApp user whose replacement core cannot boot, I ask for the core and the failure is reported once, as the redial', async () => {
    // Given a core whose redials all fail
    const { core, runtimes, nextBoots, captures, changes } = createReportingHarness();
    const lease = await core.acquire();
    await lease.connect();
    nextBoots.push(createFailingBoot(), createFailingBoot(), createFailingBoot());

    // When the core goes down and the product asks for it
    nth(runtimes, 0).providers[0]?.goDown();
    const error: unknown = await core.acquire().catch((rejected: unknown) => rejected);
    await changes.until(() => captures.exception.mock.calls.length === 1);

    // Then the ask fails with the redial's error, captured once
    expect(error).toBeInstanceOf(CoreRedialError);
    expect(error).toMatchObject({ name: 'CoreRedialError', cause: { message: 'worker failed to start' } });
    expect(captures.exception).toHaveBeenCalledTimes(1);
  });

  it('As a dApp user whose core went down and whose redials all fail while nobody holds it, I see the page let go of every core', async () => {
    // Given a core under one lease, with every redial failing
    const onCoresGone = vi.fn();
    const { core, runtimes, nextBoots, counted, changes } = createReportingHarness({ onCoresGone });
    const lease = await core.acquire();
    await lease.connect();
    nextBoots.push(createFailingBoot(), createFailingBoot(), createFailingBoot());

    // When the core goes down, its holder lets it go, and the redials give up
    nth(runtimes, 0).providers[0]?.goDown();
    lease.release();
    await changes.until(() => counted('wallet.core_redial').length === 1);

    // Then no core is left
    expect(onCoresGone).toHaveBeenCalledTimes(1);
  });

  it('As a user, I open another product before the old core goes down and get a redial for the product on screen', async () => {
    // Given a connection on a core, and another product on screen
    const { core, runtimes, contexts } = createHarness();
    const lease = await core.acquire();
    await lease.connect();
    core.setProduct({ label: 'doom' });

    // When the core goes down
    nth(runtimes, 0).providers[0]?.goDown();

    // Then the redial is for the product on screen
    expect(contexts.map(context => context.product.label)).toEqual(['dotli', 'doom']);
  });

  it('As a user, I open another product while the old core redials and the old redial is dropped', async () => {
    // Given a held redial, and another product asked for
    const { core, runtimes, contexts, nextBoots, changes } = createHarness();
    const lease = await core.acquire();
    await lease.connect();
    const redial = createHeldBoot({ changes });
    nextBoots.push(redial.boot);
    nth(runtimes, 0).providers[0]?.goDown();
    core.setProduct({ label: 'other' });
    await core.acquire();

    // When the old redial boots late and the product asks again
    const late = redial.resolve();
    await changes.until(() => late.dispose.mock.calls.length === 1);
    const next = await core.acquire();

    // Then the late core is dropped and the other product's core serves
    expect(late.dispose).toHaveBeenCalledTimes(1);
    expect(contexts[1]?.isLive()).toBe(false);
    expect(contexts[2]?.product.label).toBe('other');
    expect(next.runtime).toBe(nth(runtimes, 1).runtime);
    expect(contexts).toHaveLength(3);
  });

  it('As a dApp user, I see my page name the same product again and the redial goes on', async () => {
    // Given a held redial
    const { core, runtimes, contexts, nextBoots, changes } = createHarness();
    const lease = await core.acquire();
    await lease.connect();
    const redial = createHeldBoot({ changes });
    nextBoots.push(redial.boot);
    nth(runtimes, 0).providers[0]?.goDown();

    // When the page names the same product, the redial boots and the product asks for the core
    core.setProduct({ label: 'dotli' });
    const replacement = redial.resolve();
    const next = await core.acquire();

    // Then the redial's core serves
    expect(next.runtime).toBe(replacement.runtime);
    expect(contexts[1]?.isLive()).toBe(true);
    expect(replacement.dispose).not.toHaveBeenCalled();
  });

  it('As a dApp user whose core refuses one connection and closes another, I wait and one new core is dialed', async () => {
    // Given a connection on a core, and a second connection it refused
    const { core, runtimes, contexts, outcomes, changes } = createHarness();
    const lease = await core.acquire();
    await lease.connect();
    nth(runtimes, 0).createProvider.mockRejectedValueOnce(new Error('runtime disposed'));
    const refused = lease.connect();
    await refused.catch(() => undefined);

    // When the first connection closes and the redial ends
    nth(runtimes, 0).providers[0]?.goDown();
    await changes.until(() => outcomes.length === 2 && outcomes.at(-1) === 'ok');

    // Then the refusal failed its connection and one new core was dialed
    await expect(refused).rejects.toThrow('runtime disposed');
    expect(contexts).toHaveLength(2);
  });

  it.each([
    ['in the same turn', 0],
    ['one microtask later', 1],
  ])(
    'As a user, I open another product %s as the old core redial boots and its runtime is disposed once with nothing following it',
    async (_when, microtasks) => {
      // Given a redial that boots as the core goes down
      const { core, runtimes, nextBoots, storeListeners, changes } = createHarness();
      const lease = await core.acquire();
      await lease.connect();
      const redial = createHeldBoot({ changes });
      nextBoots.push(redial.boot);
      nth(runtimes, 0).providers[0]?.goDown();
      const late = redial.resolve();

      // When the page names another product after the given turns, and the product asks for the core
      for (let tick = 0; tick < microtasks; tick++) {
        await Promise.resolve();
      }
      core.setProduct({ label: 'other' });
      await core.acquire();
      await changes.until(() => late.dispose.mock.calls.length === 1);
      await changes.until(() => storeListeners.size === 2);

      // Then the late runtime is disposed once and only the old and new cores follow the store
      expect(late.dispose).toHaveBeenCalledTimes(1);
      expect(storeListeners.size).toBe(2);
    },
  );

  it('As a user, I log in on the landing page and my core pairs as Polkadot Web while the product later gets its own', async () => {
    // Given a core booted on the landing page
    const { core, runtimes, contexts } = createHarness();
    await core.acquire();

    // When the page names a product and it connects
    core.setProduct({ label: 'doom' });
    const lease = await core.acquire();
    await lease.connect({ executionKind: 'Worker' });

    // Then the landing core paired as Polkadot Web and the product got its own
    expect(contexts.map(context => context.product.label)).toEqual(['dotli', 'doom']);
    expect(contexts[0]?.product.pairing?.label).toBe('Polkadot Web');
    expect(nth(runtimes, 1).createProvider).toHaveBeenCalledWith({
      productId: toProductId('doom'),
      executionKind: 'Worker',
    });
  });

  it('As a product, I connect and my connection runs under the id my core parsed, not the one I asked for', async () => {
    // Given a core that parsed the product's id into its canonical form
    const { core, changes, nextBoots } = createHarness();
    const runtime = createFakeRuntime({ changes });
    nextBoots.push(() =>
      Promise.resolve({
        runtime: runtime.runtime,
        productId: asProductId('canonical.paseo'),
        local: false,
        isStale: () => Promise.resolve(false),
      }),
    );
    core.setProduct({ label: 'doom' });
    const lease = await core.acquire();

    // When the product connects
    const connection = await lease.connect();

    // Then the provider and the connection carry the parsed id
    expect(runtime.createProvider).toHaveBeenCalledWith({ productId: 'canonical.paseo', executionKind: 'App' });
    expect(connection.productId).toBe('canonical.paseo');
  });

  it('As a Polkadot App user, I log in from another tab and the login reaches my core until its last lease goes', async () => {
    // Given a core that follows the store
    const { core, runtimes, storeListeners, changes } = createHarness();
    const lease = await core.acquire();
    const runtime = nth(runtimes, 0);
    await changes.until(() => runtime.notifySessionStoreChanged.mock.calls.length === 1);

    // When the store changes, then the last lease goes
    for (const listener of storeListeners) {
      listener();
    }
    lease.release();

    // Then the core heard the change and the store has no listener left
    expect(runtime.notifySessionStoreChanged).toHaveBeenCalledTimes(2);
    expect(storeListeners.size).toBe(0);
  });

  it('As a local wallet user, I boot my core and it follows no stored session', async () => {
    // Given a local wallet page
    const { core, storeListeners } = createHarness({ local: true });

    // When the core boots
    await core.acquire();

    // Then it follows no store
    expect(storeListeners.size).toBe(0);
  });

  it('As a Polkadot App user, I close the login modal and my core cancels the pairing', async () => {
    // Given a booted core
    const { core, runtimes, changes } = createHarness();
    await core.acquire();

    // When the modal closes
    core.cancelPairing();
    await changes.until(() => nth(runtimes, 0).cancelPairing.mock.calls.length === 1);

    // Then the core cancels once
    expect(nth(runtimes, 0).cancelPairing).toHaveBeenCalledTimes(1);
  });

  it('As a local wallet user, I close the login modal and my core never receives a pairing cancel', async () => {
    // Given a booted local wallet core
    const { core, runtimes } = createHarness({ local: true });
    const lease = core.acquire();
    await lease;

    // When the modal closes
    core.cancelPairing();
    // The cancel reads the booted runtime, which settled before this wait.
    await lease;

    // Then the core heard no cancel
    expect(nth(runtimes, 0).cancelPairing).not.toHaveBeenCalled();
  });

  it('As a Polkadot App user, I close the login modal while my core is still booting and my core cancels the pairing once it boots', async () => {
    // Given a core whose boot is in flight
    const { core, nextBoots, changes } = createHarness();
    const held = createHeldBoot({ changes });
    nextBoots.push(held.boot);
    const lease = core.acquire();

    // When the modal closes before the boot ends, and the boot then ends
    core.cancelPairing();
    const runtime = held.resolve();
    await lease;
    await changes.until(() => runtime.cancelPairing.mock.calls.length === 1);

    // Then the core cancels once
    expect(runtime.cancelPairing).toHaveBeenCalledTimes(1);
  });
});

describe('page core redial reports', () => {
  it('As an operator, I watch a core go down and come back and see the redial counted as ok with the reason it went down', async () => {
    // Given a connection on a core
    const { core, runtimes, outcomes, counted, changes } = createReportingHarness();
    const lease = await core.acquire();
    await lease.connect();

    // When the core goes down and the redial is counted
    nth(runtimes, 0).providers[0]?.goDown();
    await changes.until(() => counted('wallet.core_redial').length === 1);

    // Then it is counted ok with reason closed
    expect(outcomes).toEqual(['ok', 'ok']);
    expect(counted('wallet.core_redial')).toEqual([{ outcome: 'ok', reason: 'closed' }]);
  });

  it('As an operator, I see a redial that gave up captured and counted as an error', async () => {
    // Given a core that refuses the next connection and redials that all fail
    const { core, runtimes, outcomes, nextBoots, counted, captures, changes } = createReportingHarness();
    const lease = await core.acquire();
    const failure = new Error('worker failed to start');
    nextBoots.push(
      () => Promise.reject(failure),
      () => Promise.reject(failure),
      () => Promise.reject(failure),
    );
    nth(runtimes, 0).createProvider.mockRejectedValueOnce(new Error('runtime disposed'));

    // When the product connects and the redial gives up
    const refused = lease.connect();
    await refused.catch(() => undefined);
    await changes.until(() => counted('wallet.core_redial').length === 1);

    // Then the connection failed, and the redial is captured and counted as an error
    await expect(refused).rejects.toThrow('runtime disposed');
    expect(outcomes).toEqual(['ok', 'error', 'error', 'error']);
    expect(captures.exception).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        step: 'core_redial',
        tags: { reason: 'refused' },
      }),
    );
    expect(counted('wallet.core_redial')).toEqual([{ outcome: 'error', reason: 'refused' }]);
  });

  it.each([0, 1, 2])(
    'As an operator, I drop a redial %i microtasks after its boot and see it counted as aborted, never ok',
    async microtasks => {
      // Given a redial that boots as the core goes down
      const { core, runtimes, nextBoots, counted, storeListeners, changes } = createReportingHarness();
      const lease = await core.acquire();
      await lease.connect();
      const redial = createHeldBoot({ changes });
      nextBoots.push(redial.boot);
      nth(runtimes, 0).providers[0]?.goDown();
      redial.resolve();

      // When the page names another product after the given turns, and the product asks for the core
      for (let tick = 0; tick < microtasks; tick++) {
        await Promise.resolve();
      }
      core.setProduct({ label: 'other' });
      await core.acquire();
      await changes.until(() => counted('wallet.core_redial').length === 1);
      await changes.until(() => storeListeners.size === 2);

      // Then it is counted as aborted, and the leased old core and the new one follow the store, nothing for the
      // dropped redial
      expect(counted('wallet.core_redial')).toEqual([{ outcome: 'aborted', reason: 'closed' }]);
      expect(storeListeners.size).toBe(2);
    },
  );

  it('As an operator, I see a product change drop a redial and it is counted as aborted', async () => {
    // Given a held redial
    const { core, runtimes, nextBoots, counted, changes } = createReportingHarness();
    const lease = await core.acquire();
    await lease.connect();
    const redial = createHeldBoot({ changes });
    nextBoots.push(redial.boot);
    nth(runtimes, 0).providers[0]?.goDown();

    // When the page names another product and the product asks for the core
    core.setProduct({ label: 'other' });
    await core.acquire();
    await changes.until(() => counted('wallet.core_redial').length === 1);

    // Then the redial is counted as aborted
    expect(counted('wallet.core_redial')).toEqual([{ outcome: 'aborted', reason: 'closed' }]);
  });
});

describe('page core after a failed wallet read', () => {
  it('As a local wallet user whose wallet read failed at boot, I find my wallet once the store is back and my pairing core is retired', async () => {
    // Given a pairing core booted on a wallet read that failed
    let walletFound = false;
    const { core, runtimes, contexts, storeListeners, changes } = createHarness({ walletFound: () => walletFound });
    const lease = await core.acquire();
    await lease.connect();
    const pairing = nth(runtimes, 0);

    // When the store is back with the wallet, a new core boots and the product asks for the core
    walletFound = true;
    for (const listener of [...storeListeners]) {
      listener();
    }
    await changes.until(() => contexts.length === 2);
    const next = await core.acquire();

    // Then the pairing core heard the store and the new core serves
    expect(pairing.notifySessionStoreChanged).toHaveBeenCalled();
    expect(next.runtime).toBe(nth(runtimes, 1).runtime);
  });

  it('As a local wallet user whose store came back while my pairing core booted, I finish booting and am moved to my local core', async () => {
    // Given: a pairing core booting on a wallet read that failed
    let walletFound = false;
    const { core, runtimes, contexts, storeListeners, changes } = createHarness({ walletFound: () => walletFound });
    const booting = core.acquire();

    // When: the store comes back before the core follows it, so no store event reaches the core
    walletFound = true;
    const lease = await booting;
    await changes.until(() => contexts.length === 2);
    const next = await core.acquire();

    // Then the boot served the pairing core, and the next ask gets the local core, which alone follows the store
    expect(lease.runtime).toBe(nth(runtimes, 0).runtime);
    expect(next.runtime).toBe(nth(runtimes, 1).runtime);
    expect(storeListeners.size).toBe(1);
  });

  it('As a local wallet user whose store came back, I see two store events and get one local core', async () => {
    // Given a pairing core booted on a wallet read that failed
    let walletFound = false;
    const { core, contexts, storeListeners, staleChecks, outcomes, changes } = createHarness({
      walletFound: () => walletFound,
    });
    await core.acquire();

    // When the store comes back and reports twice
    walletFound = true;
    for (const listener of [...storeListeners]) {
      listener();
      listener();
    }
    await Promise.all(staleChecks);
    await changes.until(() => outcomes.length === 2 && outcomes.at(-1) === 'ok');

    // Then one new core booted
    expect(contexts).toHaveLength(2);
    expect(outcomes).toEqual(['ok', 'ok']);
  });

  it('As a Polkadot App user, I see a stored session change and keep my core', async () => {
    // Given a pairing core with no local wallet
    const { core, contexts, storeListeners, outcomes, staleChecks } = createHarness({ walletFound: () => false });
    const lease = await core.acquire();

    // When the store reports a change and the product asks for the core
    for (const listener of [...storeListeners]) {
      listener();
    }
    await Promise.all(staleChecks);
    const next = await core.acquire();

    // Then: one check as the core first follows the store, and one for the change
    expect(staleChecks).toHaveLength(2);
    expect(next.runtime).toBe(lease.runtime);
    expect(contexts).toHaveLength(1);
    expect(outcomes).toEqual(['ok']);
  });

  it('As the page, I tell the core of a stored session change that throws and the failure is reported while the stale check still runs', async () => {
    // Given a pairing core whose runtime throws when told of a store change, and a store that now holds the wallet
    let walletFound = false;
    const { core, runtimes, storeListeners, counted, changes } = createReportingHarness({
      walletFound: () => walletFound,
    });
    recordLog({ onFinished: onTestFinished, level: 'error' });
    await core.acquire();
    const pairing = nth(runtimes, 0);
    await changes.until(() => pairing.notifySessionStoreChanged.mock.calls.length === 1);
    pairing.notifySessionStoreChanged.mockImplementation(() => {
      throw new Error('notify broke');
    });
    walletFound = true;

    // When the store reports a change
    for (const listener of [...storeListeners]) {
      listener();
    }
    await changes.until(() => counted('wallet.core_redial').length === 1);

    // Then the failure is counted once and the stale check still retired the pairing core
    expect(counted('page_core.session_follow')).toEqual([{ outcome: 'error', reason: 'Error' }]);
    expect(counted('wallet.core_redial')).toEqual([{ outcome: 'ok', reason: 'stale' }]);
  });

  it('As an operator, I see a stale check that fails on a stored session change counted, and the user keeps the core', async () => {
    // Given a pairing core whose wallet read rejects once the store changes
    let readBroken = false;
    const { core, contexts, storeListeners, staleChecks, counted, changes } = createReportingHarness({
      walletFound: () => {
        if (readBroken) {
          throw new Error('wallet read broke');
        }
        return false;
      },
    });
    recordLog({ onFinished: onTestFinished, level: 'error' });
    const lease = await core.acquire();
    await changes.until(() => staleChecks.length === 1);
    readBroken = true;

    // When the store reports a change
    for (const listener of [...storeListeners]) {
      listener();
    }
    await changes.until(() => counted('page_core.transition').length === 1);
    const next = await core.acquire();

    // Then the failure is counted once and the core stays
    expect(counted('page_core.transition')).toEqual([{ outcome: 'error', reason: 'Error' }]);
    expect(next.runtime).toBe(lease.runtime);
    expect(contexts).toHaveLength(1);
  });
});

describe('page core retirement', () => {
  it('As a dApp user whose core went down, I keep it under my product and it stops speaking for my session', async () => {
    // Given a connection on a core
    const { core, runtimes, contexts, outcomes, changes } = createHarness();
    const lease = await core.acquire();
    await lease.connect();

    // When the core goes down and the redial ends
    nth(runtimes, 0).providers[0]?.goDown();
    const downCore = { live: contexts[0]?.isLive(), inService: contexts[0]?.isInService() };
    await changes.until(() => outcomes.length === 2 && outcomes.at(-1) === 'ok');

    // Then the old core stayed live out of service, and the new one serves
    expect(downCore).toEqual({ live: true, inService: false });
    expect(contexts[1]?.isInService()).toBe(true);
  });

  it('As a user, I open another product while a login still holds the old core and it speaks for my session until it goes down', async () => {
    // Given a core a product change replaced while its lease is still held
    const { core, runtimes, contexts, outcomes } = createHarness();
    core.setProduct({ label: 'first' });
    const kept = await core.acquire();
    await kept.connect();
    core.setProduct({ label: 'second' });
    await core.acquire();
    const inServiceBefore = contexts[0]?.isInService();

    // When the old core goes down
    nth(runtimes, 0).providers[0]?.goDown();

    // Then it spoke for the session until now, and the page dials nothing for the product it left
    expect(inServiceBefore).toBe(true);
    expect(contexts[0]?.isLive()).toBe(true);
    expect(contexts[0]?.isInService()).toBe(false);
    expect(contexts[1]?.isInService()).toBe(true);
    expect(contexts).toHaveLength(2);
    expect(outcomes).toEqual(['ok', 'ok']);
  });
});

describe('page core with nobody holding it', () => {
  /** A replacement core nobody took a lease on, since its only holder released the core that went down. */
  async function createUnheldReplacement() {
    let walletFound = false;
    const fakes = createReportingHarness({ walletFound: () => walletFound });
    const lease = await fakes.core.acquire();
    await lease.connect();
    nth(fakes.runtimes, 0).providers[0]?.goDown();
    await fakes.changes.until(() => fakes.outcomes.length === 2);
    lease.release();
    // The replacement follows the store, and checks itself, once as it boots.
    await fakes.changes.until(() => nth(fakes.runtimes, 1).notifySessionStoreChanged.mock.calls.length === 1);

    function markWalletFound(found: boolean): void {
      walletFound = found;
    }

    return {
      ...fakes,
      /** Whether a wallet read now finds the local wallet. */
      setWalletFound: markWalletFound,
    };
  }

  it('As a dotli integrator, I let an unheld core die and no replacement is booted until someone asks for one', async () => {
    // Given an unheld replacement
    const { runtimes, contexts, storeListeners, staleChecks, counted, changes, setWalletFound } =
      await createUnheldReplacement();

    // When the replacement turns stale, as another tab logs in with the local wallet
    setWalletFound(true);
    for (const listener of [...storeListeners]) {
      listener();
    }
    await Promise.all(staleChecks);
    await changes.until(() => nth(runtimes, 1).dispose.mock.calls.length === 1);

    // Then it goes, and nothing is booted in its place
    expect(nth(runtimes, 1).dispose).toHaveBeenCalledTimes(1);
    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.isLive()).toBe(false);
    expect(storeListeners.size).toBe(0);
    expect(counted('wallet.core_redial')).toEqual([{ outcome: 'ok', reason: 'closed' }]);
  });

  it('As a user signing in after the unheld core died, I ask for the core and get a fresh one', async () => {
    // Given an unheld replacement that turned stale and went
    const { core, runtimes, contexts, storeListeners, staleChecks, changes, setWalletFound } =
      await createUnheldReplacement();
    setWalletFound(true);
    for (const listener of [...storeListeners]) {
      listener();
    }
    await Promise.all(staleChecks);
    await changes.until(() => nth(runtimes, 1).dispose.mock.calls.length === 1);

    // When the sign-in asks for the core
    const lease = await core.acquire();

    // Then a third core boots for it
    expect(contexts).toHaveLength(3);
    expect(lease.runtime).toBe(nth(runtimes, 2).runtime);
    expect(contexts[2]?.isInService()).toBe(true);
  });

  it('As a dApp user holding the core when it dies, I hear it go and get a replacement at once', async () => {
    // Given a product that took the unheld replacement and connected on it
    const { core, runtimes, contexts, outcomes, changes } = await createUnheldReplacement();
    const lease = await core.acquire();
    await lease.connect();
    const heard: number[] = [];
    lease.subscribeDown(() => {
      heard.push(contexts.length);
    });

    // When the core dies, the replacement boots and the product asks for the core
    nth(runtimes, 1).providers[0]?.goDown();
    const heardOnDown = [...heard];
    await changes.until(() => outcomes.length === 3 && outcomes.at(-1) === 'ok');
    const next = await core.acquire();

    // Then the product heard once the replacement was asked for, and gets it
    expect(heardOnDown).toEqual([3]);
    expect(next.runtime).toBe(nth(runtimes, 2).runtime);
  });
});
