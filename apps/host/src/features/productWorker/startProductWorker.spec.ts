// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { asProductId } from '@parity/truapi';
import type { ExecutableKind, WorkerDemandChange } from '@parity/truapi-host';
import { recordReports } from '@dotli/metrics/testing';
import { createAsyncTaskPool, createDeferred, noop } from '@dotli/shared';
import type { ModuleFiles } from '@dotli/quickjs-runtime';
import type { WorkerExecutable } from '../productLoad/index.js';
import type { CoreConnection, CoreProvider } from '../productRuntime/index.js';
import { createChanges, type Changes } from '../../testing/changes.js';
import { startProductWorker, type WorkerLease } from './startProductWorker.js';

const PRODUCT_ID = asProductId('shop');

const EXECUTABLE: WorkerExecutable = { entrypoint: 'index.js', includes: { chat: false }, cid: 'bafy-worker' };

const CHAT_EXECUTABLE: WorkerExecutable = { ...EXECUTABLE, includes: { chat: true } };

const FILES: ModuleFiles = new Map([['index.js', new TextEncoder().encode('export {};')]]);

type HarnessParams = {
  /** What the product publishes. A worker by default. */
  executable?: WorkerExecutable | null;
  /** Holds the first executable read until the test lets it through. */
  holdFirstRead?: boolean;
};

/** One worker over a fake page core, whose leases, ledger, reads and VMs the test drives. */
function createHarness({ executable = EXECUTABLE, holdFirstRead = false }: HarnessParams = {}) {
  const changes = createChanges();
  const reports = recordReports({ onFinished: onTestFinished });
  const passes = createAsyncTaskPool({ poolSize: 1 });
  const leases: FakeLease[] = [];
  const vms: FakeVm[] = [];
  const served: ServedChat[] = [];
  const heldRead = createDeferred<undefined>();
  let reads = 0;

  return {
    changes,
    reports,
    leases,
    vms,
    served,
    reads: () => reads,
    releaseRead: () => {
      heldRead.resolve(undefined);
    },
    /** Starts the worker, which the test stops when it finishes. */
    start(): () => void {
      const stop = startProductWorker({
        label: 'shop',
        core: {
          acquire: () => {
            const lease = createFakeLease(changes);
            leases.push(lease);
            return Promise.resolve(lease.lease);
          },
        },
        readExecutable: async () => {
          reads += 1;
          changes.notify();
          if (holdFirstRead && reads === 1) {
            await heldRead.promise;
          }
          return executable;
        },
        readFiles: () => Promise.resolve(FILES),
        openGate: () => ({ isHostAllowed: () => Promise.resolve(false), dispose: noop }),
        startVm: () => {
          const vm = createFakeVm(changes);
          vms.push(vm);
          changes.notify();
          return vm.vm;
        },
        serveChat: (connection, files) => {
          const chat = { connection, files, stopped: false };
          served.push(chat);
          return () => {
            chat.stopped = true;
          };
        },
        passes,
      });
      onTestFinished(stop);
      return stop;
    },
    /** Resolves once every pass queued so far has run. */
    settled: () => passes.call(noop),
    /** Resolves once the worker runs its `count`th VM. */
    running: (count = 1) => changes.until(() => vms.length === count),
  };
}

/** A chat the worker served, on which connection and with which files, and whether it stopped. */
type ServedChat = { connection: CoreConnection; files: ModuleFiles; stopped: boolean };

type FakeLease = ReturnType<typeof createFakeLease>;

/** A lease whose ledger counts references as the core does, and whose demand and core loss the test drives. */
function createFakeLease(changes: Changes) {
  let references = 0;
  let released = false;
  let downListener: (() => void) | null = null;
  const demandListeners = new Set<(change: WorkerDemandChange) => void>();
  const connections: ExecutableKind[] = [];
  const opened: CoreConnection[] = [];
  const providers: { disposed: boolean }[] = [];

  function setDemand(wanted: boolean): void {
    for (const listener of [...demandListeners]) {
      listener({ productId: PRODUCT_ID, wanted });
    }
  }

  const lease: WorkerLease = {
    productId: PRODUCT_ID,
    runtime: {
      acquireWorker: () => {
        references += 1;
        if (references === 1) {
          setDemand(true);
        }
      },
      releaseWorker: () => {
        references -= 1;
        if (references === 0) {
          setDemand(false);
        }
      },
      subscribeWorkerDemand: listener => {
        demandListeners.add(listener);
        if (references > 0) {
          listener({ productId: PRODUCT_ID, wanted: true });
        }
        changes.notify();
        return () => {
          demandListeners.delete(listener);
        };
      },
    },
    connect: ({ executionKind = 'App' } = {}) => {
      connections.push(executionKind);
      // The worker hands the connection on to `own` and the chat it serves, which the fakes answer without reading it.
      const connection = { productId: PRODUCT_ID, close: noop } as unknown as CoreConnection;
      opened.push(connection);
      return Promise.resolve(connection);
    },
    own: () => {
      const provider = createFakeProvider(changes);
      providers.push(provider.state);
      return provider.provider;
    },
    subscribeDown: listener => {
      downListener = listener;
      return () => {
        downListener = null;
      };
    },
    release: () => {
      released = true;
      changes.notify();
    },
  };

  return {
    lease,
    connections,
    opened,
    providers,
    references: () => references,
    released: () => released,
    subscribed: () => demandListeners.size > 0,
    /** Tells every demand listener the worker is wanted or not, as other holders come and go. */
    setDemand,
    /** The core under the lease goes down. */
    goDown: () => {
      downListener?.();
    },
  };
}

type FakeVm = ReturnType<typeof createFakeVm>;

function createFakeVm(changes: Changes) {
  const channel = new MessageChannel();
  const run = createDeferred<undefined>();
  let disposed = false;
  return {
    vm: {
      wire: channel.port1,
      run: run.promise,
      dispose: () => {
        disposed = true;
        channel.port1.close();
        changes.notify();
      },
    },
    /** Ends the run as the entrypoint throwing. */
    fail: (error: Error) => {
      run.reject(error);
    },
    disposed: () => disposed,
  };
}

function createFakeProvider(changes: Changes) {
  const state = { disposed: false };
  const provider: CoreProvider = {
    postMessage: noop,
    subscribe: () => noop,
    subscribeClose: () => noop,
    getPermissionAuthorizationStatus: () => Promise.resolve('NotDetermined'),
    getPermissionAuthorizationStatuses: requests => Promise.resolve(requests.map(() => 'NotDetermined')),
    setPermissionAuthorizationStatus: () => Promise.resolve(),
    dispose: () => {
      state.disposed = true;
      changes.notify();
    },
  };
  return { provider, state };
}

describe('startProductWorker', () => {
  it('As a page whose product publishes a worker, I run it in one VM on a Worker-kind connection', async () => {
    // Given
    const harness = createHarness();

    // When
    harness.start();
    await harness.running();

    // Then
    expect(harness.leases.map(lease => lease.connections)).toEqual([['Worker']]);
  });

  it('As a page, I end the VM and its connection once the core no longer wants the worker', async () => {
    // Given
    const harness = createHarness();
    harness.start();
    await harness.running();
    const [lease] = harness.leases;

    // When
    lease?.setDemand(false);

    // Then
    expect({ vm: harness.vms[0]?.disposed(), connection: lease?.providers[0]?.disposed }).toEqual({
      vm: true,
      connection: true,
    });
  });

  it('As a page whose product publishes no worker, I run nothing', async () => {
    // Given
    const harness = createHarness({ executable: null });

    // When
    harness.start();
    await harness.changes.until(() => harness.leases[0]?.subscribed() === true);
    await harness.settled();

    // Then
    expect({ reads: harness.reads(), connections: harness.leases[0]?.connections, vms: harness.vms }).toEqual({
      reads: 1,
      connections: [],
      vms: [],
    });
  });

  it('As a page whose worker failed, I report it and run it again only once the demand turns wanted again', async () => {
    // Given
    const harness = createHarness();
    harness.start();
    await harness.running();
    const [lease] = harness.leases;

    // When
    harness.vms[0]?.fail(new Error('The entrypoint threw'));
    await harness.changes.until(() => harness.vms[0]?.disposed() === true);
    lease?.setDemand(true);
    await harness.settled();
    const runsBeforeTurn = harness.vms.length;
    lease?.setDemand(false);
    lease?.setDemand(true);
    await harness.running(2);

    // Then
    expect(harness.reports.expected).toMatchObject([{ step: 'worker_run' }]);
    expect(runsBeforeTurn).toBe(1);
  });

  it('As a page whose core went down, I take the reference again on the replacement and run the worker there', async () => {
    // Given
    const harness = createHarness();
    harness.start();
    await harness.running();
    const [first] = harness.leases;

    // When
    first?.goDown();
    await harness.running(2);

    // Then
    const [, replacement] = harness.leases;
    expect({
      vm: harness.vms[0]?.disposed(),
      firstReferences: first?.references(),
      firstReleased: first?.released(),
      replacementReferences: replacement?.references(),
      replacementConnections: replacement?.connections,
    }).toEqual({
      vm: true,
      firstReferences: 0,
      firstReleased: true,
      replacementReferences: 1,
      replacementConnections: ['Worker'],
    });
  });

  it('As a page leaving the product, I release the reference and the lease as I stop', async () => {
    // Given
    const harness = createHarness();
    const stop = harness.start();
    await harness.running();
    const [lease] = harness.leases;

    // When
    stop();

    // Then
    expect({ vm: harness.vms[0]?.disposed(), references: lease?.references(), released: lease?.released() }).toEqual({
      vm: true,
      references: 0,
      released: true,
    });
  });

  it('As a page, I start the worker once for demand that repeats while it starts', async () => {
    // Given
    const harness = createHarness({ holdFirstRead: true });
    harness.start();
    await harness.changes.until(() => harness.reads() === 1);
    const [lease] = harness.leases;

    // When
    lease?.setDemand(true);
    lease?.setDemand(true);
    harness.releaseRead();
    await harness.running();
    await harness.settled();

    // Then
    expect({ vms: harness.vms.length, reads: harness.reads() }).toEqual({ vms: 1, reads: 1 });
  });

  it('As a page whose product declares chat, I serve chat on its worker connection with the files the run read', async () => {
    // Given
    const harness = createHarness({ executable: CHAT_EXECUTABLE });

    // When
    harness.start();
    await harness.running();

    // Then
    const [lease] = harness.leases;
    expect(harness.served).toHaveLength(1);
    expect(harness.served[0]?.connection).toBe(lease?.opened[0]);
    expect(harness.served[0]?.files).toBe(FILES);
  });

  it('As a page whose product declares no chat, I serve no chat', async () => {
    // Given
    const harness = createHarness();

    // When
    harness.start();
    await harness.running();

    // Then
    expect(harness.served).toEqual([]);
  });

  it.each([
    ['the core no longer wants the worker', (lease: FakeLease | undefined) => lease?.setDemand(false)],
    ['the core under it goes down', (lease: FakeLease | undefined) => lease?.goDown()],
    ['the page stops the worker', (_lease: FakeLease | undefined, stop: () => void) => stop()],
  ] as const)('As a page, I stop serving chat as the run ends when %s', async (_case, end) => {
    // Given
    const harness = createHarness({ executable: CHAT_EXECUTABLE });
    const stop = harness.start();
    await harness.running();

    // When
    end(harness.leases[0], stop);

    // Then
    expect(harness.served[0]?.stopped).toBe(true);
  });
});
