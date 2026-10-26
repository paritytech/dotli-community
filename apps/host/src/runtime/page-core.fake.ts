// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { vi, type Mock } from 'vitest';
import {
  decodeWireMessage,
  encodeWireMessage,
  MESSAGE_TYPE_RESPONSE,
  scale,
  VersionedHostRequestLoginError,
  VersionedHostRequestLoginResponse,
  type WireProvider,
} from '@parity/truapi';
import type { WorkerPairingHostRuntime } from '@parity/truapi-host/web';
import { ACCOUNT_REQUEST_LOGIN } from '@parity/truapi/wire-table';
import { createAsyncTaskPool } from '@dotli/shared';
import { createBlockingModalCoordinator } from './blocking-modal-queue.js';
import type { BootedCoreRuntime } from './core-runtime.js';
import { createPageCore, type PageCore } from './page-core.js';
import { createChanges, type Changes } from '../testing/changes.js';

type ProviderListener = (message: Uint8Array) => void;
type ProviderCloseListener = (error: Error) => void;

/** A core connection the test speaks for. `listener` and `closeListener` are the core's side of it. */
export interface FakeCoreProvider {
  listener: ProviderListener | null;
  closeListener: ProviderCloseListener | null;
  postMessage: Mock<WireProvider['postMessage']>;
  subscribe: Mock<(callback: ProviderListener) => () => void>;
  subscribeClose: Mock<(callback: ProviderCloseListener) => () => void>;
  getPermissionAuthorizationStatus: Mock<() => Promise<string>>;
  getPermissionAuthorizationStatuses: Mock<(requests: unknown[]) => Promise<string[]>>;
  setPermissionAuthorizationStatus: Mock<() => Promise<void>>;
  dispose: Mock<() => void>;
  /** Told of each message the core posts and each dispose, which {@link answerConnection} points at its fakes. */
  changed: () => void;
}

export interface FakeCoreRuntime {
  createProvider: Mock<() => Promise<FakeCoreProvider>>;
  cancelPairing: Mock<() => void>;
  disconnectSession: Mock<() => Promise<void>>;
  notifySessionStoreChanged: Mock<() => void>;
  dispose: Mock<() => void>;
}

export interface FakePageCore {
  core: PageCore;
  /** Every runtime a boot produced, in order. */
  runtimes: FakeCoreRuntime[];
  /** Every connection asked of any core, in order, each answered by the test. */
  connections: PromiseWithResolvers<FakeCoreProvider>[];
  /** Queues how the next boots end: a runtime to adjust, or an error to fail with. */
  nextBoots: ((runtime: FakeCoreRuntime) => Error | undefined)[];
  /** Every boot held by {@link FakePageCore.holdBoots}, in order, each let through by the test. */
  heldBoots: PromiseWithResolvers<undefined>[];
  /** Holds every later boot until the test lets it through, as a cold wallet core still starting. */
  holdBoots(): void;
  /** The local wallet turning up, as another tab logged in, so pairing cores turn stale and later boots are local. */
  findLocalWallet(): void;
  /** Notified at each connection asked and each call on a runtime or an answered connection. */
  changes: Changes;
}

/** A connection that answers nothing, for a product frame the test only places. */
export function makeProvider(options: { onPostMessage?: (message: Uint8Array) => void } = {}): FakeCoreProvider {
  const provider: FakeCoreProvider = {
    listener: null,
    closeListener: null,
    postMessage: vi.fn((message: Uint8Array) => {
      options.onPostMessage?.(message);
      provider.changed();
    }),
    subscribe: vi.fn((callback: ProviderListener) => {
      provider.listener = callback;
      return () => {
        provider.listener = null;
      };
    }),
    subscribeClose: vi.fn((callback: ProviderCloseListener) => {
      provider.closeListener = callback;
      return () => {
        provider.closeListener = null;
      };
    }),
    getPermissionAuthorizationStatus: vi.fn(() => Promise.resolve('NotDetermined')),
    getPermissionAuthorizationStatuses: vi.fn((requests: unknown[]) =>
      Promise.resolve(requests.map(() => 'NotDetermined')),
    ),
    setPermissionAuthorizationStatus: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(() => {
      provider.changed();
    }),
    changed: () => undefined,
  };
  return provider;
}

function makeRuntime(connections: PromiseWithResolvers<FakeCoreProvider>[], changes: Changes): FakeCoreRuntime {
  return {
    createProvider: vi.fn(() => {
      const connection = Promise.withResolvers<FakeCoreProvider>();
      connections.push(connection);
      changes.notify();
      return connection.promise;
    }),
    cancelPairing: vi.fn(changes.notify),
    disconnectSession: vi.fn(() => {
      changes.notify();
      return Promise.resolve();
    }),
    notifySessionStoreChanged: vi.fn(changes.notify),
    dispose: vi.fn(changes.notify),
  };
}

/** The real page core over fake Polkadot App runtimes. A redial gets one attempt, so a failed one fails at once. */
export function createFakePageCore(): FakePageCore {
  const runtimes: FakeCoreRuntime[] = [];
  const connections: PromiseWithResolvers<FakeCoreProvider>[] = [];
  const nextBoots: ((runtime: FakeCoreRuntime) => Error | undefined)[] = [];
  const storeListeners = new Set<() => void>();
  const heldBoots: PromiseWithResolvers<undefined>[] = [];
  const changes = createChanges();
  let walletFound = false;
  let holding = false;
  const boot = (): Promise<BootedCoreRuntime> => {
    const runtime = makeRuntime(connections, changes);
    const failure = nextBoots.shift()?.(runtime);
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    runtimes.push(runtime);
    changes.notify();
    const local = walletFound;
    return Promise.resolve({
      runtime: runtime as unknown as WorkerPairingHostRuntime,
      local,
      stale: () => Promise.resolve(!local && walletFound),
    });
  };
  const core = createPageCore({
    bootRuntime: () => {
      if (!holding) {
        return boot();
      }
      const held = Promise.withResolvers<undefined>();
      heldBoots.push(held);
      changes.notify();
      return held.promise.then(boot);
    },
    onStoredSessionChanged: listener => {
      storeListeners.add(listener);
      return () => {
        storeListeners.delete(listener);
      };
    },
    coordinator: createBlockingModalCoordinator(),
    redials: createAsyncTaskPool({ poolSize: 1 }),
    destroyDelay: 0,
  });
  return {
    core,
    runtimes,
    connections,
    nextBoots,
    heldBoots,
    holdBoots() {
      holding = true;
    },
    changes,
    findLocalWallet() {
      walletFound = true;
      for (const listener of [...storeListeners]) {
        listener();
      }
    },
  };
}

/** Answers the next connection asked of the core. */
export async function answerConnection(
  fakes: FakePageCore,
  index: number,
  provider: FakeCoreProvider = makeProvider(),
): Promise<FakeCoreProvider> {
  await fakes.changes.until(() => fakes.connections.length > index);
  provider.changed = fakes.changes.notify;
  fakes.connections[index]?.resolve(provider);
  return provider;
}

export function loginResponseFrame(
  requestId: string,
  result:
    | { success: true; value: 'Success' | 'AlreadyConnected' | 'Rejected' }
    | { success: false; reason: string }
    | { success: false; hostFailure: string }
    | { success: false; cancelled: true },
): Uint8Array {
  // Codec 2 legs carry Result outside and the version wrapper inside.
  const responseCodec = scale.Result(
    VersionedHostRequestLoginResponse,
    scale.CallError(VersionedHostRequestLoginError),
  );
  const value = responseCodec.enc(
    result.success
      ? { success: true, value: { tag: 'V1', value: result.value } }
      : 'cancelled' in result
        ? { success: false, value: { tag: 'Cancelled' } }
        : 'hostFailure' in result
          ? { success: false, value: { tag: 'HostFailure', value: { reason: result.hostFailure } } }
          : {
              success: false,
              value: {
                tag: 'Domain',
                value: { tag: 'V1', value: { tag: 'Unknown', value: { reason: result.reason } } },
              },
            },
  );
  const frame = encodeWireMessage({
    requestId,
    payload: {
      traitId: ACCOUNT_REQUEST_LOGIN.trait,
      methodId: ACCOUNT_REQUEST_LOGIN.method,
      messageType: MESSAGE_TYPE_RESPONSE,
      value,
    },
  });
  if (frame.isErr()) {
    throw frame.error;
  }
  return frame.value;
}

export function requestIdFromFrame(message: Uint8Array): string {
  const decoded = decodeWireMessage(message);
  if (decoded.isErr()) {
    throw decoded.error;
  }
  return decoded.value.requestId;
}
