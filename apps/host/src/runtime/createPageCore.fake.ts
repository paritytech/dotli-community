// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { vi } from 'vitest';
import { asProductId, type ProductId } from '@parity/truapi';
import type { WorkerPairingHostRuntime } from '@parity/truapi-host/web';
import { createAsyncTaskPool, createDeferred, noop } from '@dotli/shared';
import { createBlockingModalCoordinator } from './createBlockingModalCoordinator.js';
import type { BootedCoreRuntime } from './createCoreRuntimeBoot.js';
import { createPageCore, type CoreContext } from './createPageCore.js';
import { getAskedProductId } from './createTruapiRuntimeConfig.js';
import { createChanges, type Changes } from '../testing/changes.js';

type ProviderListener = (message: Uint8Array) => void;
type ProviderCloseListener = (error: Error) => void;

/** A core connection the test speaks for. `listener` and `closeListener` are the core's side of it. */
export type FakeCoreProvider = ReturnType<typeof createFakeProvider>;

/** A Polkadot App runtime whose connections the test answers. */
export type FakeCoreRuntime = ReturnType<typeof createFakeRuntime>;

export type FakePageCore = ReturnType<typeof createFakePageCore>;

type AnswerConnectionParams = {
  /** The connection the core gets, one that answers nothing by default. */
  provider?: FakeCoreProvider;
};

type CreateFakeProviderParams = {
  /** Told of each message the core posts. */
  onPostMessage?: (message: Uint8Array) => void;
};

type CreateFakeRuntimeParams = {
  /** Where each connection the runtime is asked for goes, for the test to answer. */
  connections: ReturnType<typeof createDeferred<FakeCoreProvider>>[];
  /** Notified at each call on the runtime. */
  changes: Changes;
};

type CreateFakePageCoreParams = {
  /** How a core parses the id it is asked for. As asked by default. */
  parseProductId?: (asked: string) => ProductId;
  /**
   * Whether a core nobody holds outlives its last lease for good, as within the page's destroy delay. By default it
   * goes at once.
   */
  linger?: boolean;
};

/** The real page core over fake Polkadot App runtimes. A redial gets one attempt, so a failed one fails at once. */
export function createFakePageCore({ parseProductId = asProductId, linger = false }: CreateFakePageCoreParams = {}) {
  const runtimes: FakeCoreRuntime[] = [];
  const connections: ReturnType<typeof createDeferred<FakeCoreProvider>>[] = [];
  const nextBoots: ((runtime: FakeCoreRuntime) => Error | undefined)[] = [];
  const storeListeners = new Set<() => void>();
  const heldBoots: ReturnType<typeof createDeferred<undefined>>[] = [];
  const changes = createChanges();
  let walletFound = false;
  let holding = false;
  const core = createPageCore({
    bootRuntime(context) {
      if (!holding) {
        return boot(context);
      }
      const held = createDeferred<undefined>();
      heldBoots.push(held);
      changes.notify();
      return held.promise.then(() => boot(context));
    },
    subscribeStoredSession(listener) {
      storeListeners.add(listener);
      return () => {
        storeListeners.delete(listener);
      };
    },
    coordinator: createBlockingModalCoordinator(),
    redials: createAsyncTaskPool({ poolSize: Number.POSITIVE_INFINITY }),
    // A core that lingers does so for good, as the test never lets the destroy delay end.
    destroyDelay: linger ? 1 : 0,
    timers: { setTimeout: () => undefined, clearTimeout: noop },
  });

  function boot({ product }: CoreContext): Promise<BootedCoreRuntime> {
    const runtime = createFakeRuntime({ connections, changes });
    const failure = nextBoots.shift()?.(runtime);
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    runtimes.push(runtime);
    changes.notify();
    const local = walletFound;
    return Promise.resolve({
      // The fake has the members the page core calls, not the full runtime interface.
      runtime: runtime as unknown as WorkerPairingHostRuntime,
      productId: parseProductId(getAskedProductId(product)),
      local,
      isStale: () => Promise.resolve(!local && walletFound),
    });
  }

  return {
    /** The real page core under test. */
    core,
    /** Every runtime a boot produced, in order. */
    runtimes,
    /** Every connection asked of any core, in order, each answered by the test. */
    connections,
    /** Queues how the next boots end: a runtime to adjust, or an error to fail with. */
    nextBoots,
    /** Every boot `holdBoots` held, in order, each let through by the test. */
    heldBoots,
    /** Holds every later boot until the test lets it through, as a cold wallet core still starting. */
    holdBoots(): void {
      holding = true;
    },
    /** Notified at each connection asked and each call on a runtime or an answered connection. */
    changes,
    /** The local wallet turning up, as another tab logged in, so pairing cores turn stale and later boots are local. */
    findLocalWallet(): void {
      walletFound = true;
      for (const listener of [...storeListeners]) {
        listener();
      }
    },
  };
}

/** Answers connection `index` once the core asks for it, and resolves the connection it answered with. */
export async function answerConnection(
  fakes: FakePageCore,
  index: number,
  { provider = createFakeProvider() }: AnswerConnectionParams = {},
): Promise<FakeCoreProvider> {
  await fakes.changes.until(() => fakes.connections.length > index);
  provider.changed = fakes.changes.notify;
  fakes.connections[index]?.resolve(provider);
  return provider;
}

/** A connection that answers nothing, for a product frame the test only places. */
export function createFakeProvider({ onPostMessage }: CreateFakeProviderParams = {}) {
  let listener: ProviderListener | null = null;
  let closeListener: ProviderCloseListener | null = null;
  const provider = {
    /** The core's frame listener, or null while nothing listens. */
    get listener(): ProviderListener | null {
      return listener;
    },
    /** The core's close listener, or null while nothing listens. */
    get closeListener(): ProviderCloseListener | null {
      return closeListener;
    },
    /** Records each frame posted to the core. */
    postMessage: vi.fn((message: Uint8Array) => {
      onPostMessage?.(message);
      provider.changed();
    }),
    /** Holds `callback` as the frame listener until the returned unsubscribe runs. */
    subscribe: vi.fn((callback: ProviderListener) => {
      listener = callback;
      return () => {
        listener = null;
      };
    }),
    /** Holds `callback` as the close listener until the returned unsubscribe runs. */
    subscribeClose: vi.fn((callback: ProviderCloseListener) => {
      closeListener = callback;
      return () => {
        closeListener = null;
      };
    }),
    /** Answers every permission as not determined. */
    getPermissionAuthorizationStatus: vi.fn(() => Promise.resolve('NotDetermined')),
    /** Answers every permission as not determined. */
    getPermissionAuthorizationStatuses: vi.fn((requests: unknown[]) =>
      Promise.resolve(requests.map(() => 'NotDetermined')),
    ),
    /** Accepts every permission change. */
    setPermissionAuthorizationStatus: vi.fn(() => Promise.resolve()),
    /** Records the connection's dispose. */
    dispose: vi.fn(() => {
      provider.changed();
    }),
    /** Told of each message the core posts and each dispose. Does nothing until a test points it elsewhere. */
    changed: (): void => undefined,
  };
  return provider;
}

function createFakeRuntime({ connections, changes }: CreateFakeRuntimeParams) {
  return {
    /** Asks for a connection the test answers, in `connections`. */
    createProvider: vi.fn(() => {
      const connection = createDeferred<FakeCoreProvider>();
      connections.push(connection);
      changes.notify();
      return connection.promise;
    }),
    /** Records a pairing cancel. */
    cancelPairing: vi.fn<() => void>(changes.notify),
    /** Records a session disconnect, which settles at once. */
    disconnectSession: vi.fn(() => {
      changes.notify();
      return Promise.resolve();
    }),
    /** Records a stored session change told to the core. */
    notifySessionStoreChanged: vi.fn<() => void>(changes.notify),
    /** Records the runtime's dispose. */
    dispose: vi.fn<() => void>(changes.notify),
  };
}
