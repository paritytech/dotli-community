// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The chain client is passed in through `open`, so each test hands the resolver fake reads and halts.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { must } from '@dotli/shared/testing';
import type { JsonRpcConnection, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { DisjointError, RpcError } from '@polkadot-api/substrate-client';
import { atom } from 'nanostores';
import { getActiveServicesConfig } from '@dotli/config';
import { bindLogSink } from '@dotli/shared';
import { ApiStoppedError } from './apiStoppedError.js';
import { createDotnsResolver, type DotnsResolver } from './createDotnsResolver.js';
import type { Api } from './createRawApi.js';
import type { ChainClient } from './createSyncedClient.js';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';

/** A chain client whose follow can be stopped from the test. */
type FakeClient = {
  /** Stops the follow, as a halted chain would, and tells every stop listener. */
  stop: () => void;
  /** Disconnects the client's Asset Hub lease. */
  destroy: Mock<() => void>;
} & ChainClient;

/** How one client behaves: its sync, and what a slot read answers. */
type ApiShape = {
  /** Settles when the follow reaches its first block. Resolves at once unless set. */
  whenReady?: () => Promise<void>;
  /** Every slot read rejects with this. */
  readFails?: Error;
  /** The chain halts under the read, in the pool's order: the read is answered first, then the follow stops. */
  haltsOnRead?: boolean;
  /** The follow stops as it reaches its first block: `whenReady` stops it, then resolves. */
  stopsAsReady?: boolean;
};

/** Hands out clients in order, each shaped by the next entry, and plain ones once the list runs out. */
function createFakeClients(shapes: ApiShape[] = []): {
  open: (provider: JsonRpcProvider) => FakeClient;
  opened: FakeClient[];
} {
  const opened: FakeClient[] = [];
  function open(provider: JsonRpcProvider): FakeClient {
    const shape = shapes.shift() ?? {};
    // Connected as papi's client would, so the test sees each lease taken and released.
    const connection = provider(() => undefined);
    const stops: (() => void)[] = [];
    let stopped = false;
    function stop(): void {
      stopped = true;
      for (const callback of stops.splice(0)) {
        callback();
      }
    }
    const api: Api = {
      whenReady:
        shape.whenReady ??
        (() => {
          if (shape.stopsAsReady === true) {
            stop();
          }
          return Promise.resolve();
        }),
      withBestBlock: <T>(read: (hash: string) => Promise<T>) =>
        stopped ? Promise.reject(new ApiStoppedError()) : read('0x01'),
      resolveTrieId: () => Promise.resolve(null),
      readSlot: () => {
        if (stopped) {
          return Promise.reject(new ApiStoppedError());
        }
        const answer = shape.readFails === undefined ? Promise.resolve(null) : Promise.reject(shape.readFails);
        if (shape.haltsOnRead === true) {
          stop();
        }
        return answer;
      },
      onStop: (callback: () => void) => {
        if (stopped) {
          callback();
          return () => undefined;
        }
        stops.push(callback);
        return () => undefined;
      },
      destroy: () => undefined,
    };
    const client: FakeClient = {
      api,
      stop,
      destroy: vi.fn(() => {
        connection.disconnect();
      }),
    };
    opened.push(client);
    return client;
  }
  return { open, opened };
}

/** A client whose follow never reaches its first block: the chain halted. */
function createHaltedBeforeReadyShape(): ApiShape {
  return { whenReady: () => Promise.reject(new ApiStoppedError()) };
}

/** A client with no reachable peers, whose follow never reaches its first block. */
function createNeverReadyShape(): ApiShape {
  return { whenReady: () => new Promise<void>(() => undefined) };
}

/** A promise that rejects with `error` once `ms` pass. */
function rejectAfter(ms: number, error: Error): Promise<void> {
  return new Promise<void>((_resolve, reject) => {
    setTimeout(() => {
      reject(error);
    }, ms);
  });
}

describe('createDotnsResolver', () => {
  let disconnect: Mock<() => void>;
  let assetHub: Mock<() => JsonRpcProvider>;

  beforeEach(() => {
    onTestFinished(bindLogSink({ emit: () => undefined }));
    disconnect = vi.fn<() => void>();
    assetHub = vi.fn<() => JsonRpcProvider>(
      () => () => ({ send: vi.fn<JsonRpcConnection['send']>(), disconnect }) satisfies JsonRpcConnection,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createResolver(
    shapes: ApiShape[] = [],
    source: 'light-client' | 'rpc-gateway' = 'light-client',
  ): { dotns: DotnsResolver; opened: FakeClient[] } {
    const { open, opened } = createFakeClients(shapes);
    return {
      dotns: createDotnsResolver({ assetHub, dotns: getActiveServicesConfig().dotns, source, open }),
      opened,
    };
  }

  it("As a dotli user on a light client, I resolve names on a fresh Asset Hub lease after the chain's follow stops", async () => {
    // Given
    const { dotns, opened } = createResolver();
    await dotns.resolveOwner('alice');
    await dotns.resolveOwner('alice');
    const leasesBeforeStop = assetHub.mock.calls.length;

    // When
    must(opened[0], 'first client').stop();
    await dotns.resolveOwner('alice');

    // Then
    expect(leasesBeforeStop).toBe(1);
    expect(assetHub).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("As an operator, I see Asset Hub's follow that stopped under a ready client reported and counted as an expected failure", async () => {
    // Given a ready Asset Hub client
    const reports = recordReports({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { dotns, opened } = createResolver();
    await dotns.resolveOwner('alice');

    // When its follow stops
    must(opened[0], 'first client').stop();

    // Then the stop was reported and counted under its own step
    expect(reports.expected).toMatchObject([{ step: 'follow_stop' }]);
    expect(metrics.counted('resolve.follow_stop')).toEqual([{ outcome: 'error', reason: 'ApiStoppedError' }]);
  });

  it("As a dotli user on a light client, I resolve a name on a rebuilt client when Asset Hub's follow stops just as it syncs", async () => {
    // Given a first client whose follow stops as it reaches its first block
    const { dotns, opened } = createResolver([{ stopsAsReady: true }]);

    // When
    const owner = await dotns.resolveOwner('alice');

    // Then
    expect(owner).toBeNull();
    expect(assetHub).toHaveBeenCalledTimes(2);
    expect(must(opened[0], 'first client').destroy).toHaveBeenCalledTimes(1);
  });

  it('As the host on a cold start, I make three concurrent reads and they share one Asset Hub client', async () => {
    // Given
    const { dotns } = createResolver();

    // When
    await Promise.all([dotns.resolveDotName('alice'), dotns.resolveRootManifest('alice'), dotns.resolveOwner('bob')]);

    // Then
    expect(assetHub).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'the halted answer to a read in flight',
      new RpcError({ code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' }),
    ],
    ['a read cut off by the stop', new DisjointError()],
    ['a read after the stop', new ApiStoppedError()],
  ])(
    'As a dotli user on a light client, I still resolve a name when its chain halts under %s',
    async (_case, error) => {
      // Given
      const { dotns } = createResolver([{ readFails: error, haltsOnRead: true }]);

      // When
      const owner = await dotns.resolveOwner('alice');

      // Then
      expect(owner).toBeNull();
      expect(assetHub).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['resolveDotName', (dotns: DotnsResolver) => dotns.resolveDotName('alice')],
    ['resolveExecutableManifest', (dotns: DotnsResolver) => dotns.resolveExecutableManifest('alice', 'app')],
    ['resolveOwner', (dotns: DotnsResolver) => dotns.resolveOwner('alice')],
    ['resolveRootManifest', (dotns: DotnsResolver) => dotns.resolveRootManifest('alice')],
  ])(
    'As a dotli user on a light client, I call %s and it survives a chain that halts before its first block',
    async (_name, read) => {
      // Given
      const { dotns } = createResolver([createHaltedBeforeReadyShape()]);

      // When
      await read(dotns);

      // Then
      expect(assetHub).toHaveBeenCalledTimes(2);
    },
  );

  it('As a dotli user on a light client resuming from a recent stored database, I still resolve a name when smoldot resets the chain twice while catching up', async () => {
    // Given
    const { dotns } = createResolver([
      { readFails: new DisjointError(), haltsOnRead: true },
      { readFails: new DisjointError(), haltsOnRead: true },
    ]);

    // When
    const owner = await dotns.resolveOwner('alice');

    // Then
    expect(owner).toBeNull();
    expect(assetHub).toHaveBeenCalledTimes(3);
  });

  it('As a dotli user on a light client, I see the resolution fail after four attempts when the chain keeps halting', async () => {
    // Given
    const { dotns } = createResolver(Array.from({ length: 6 }, createHaltedBeforeReadyShape));

    // When
    const result = dotns.resolveOwner('alice');

    // Then
    await expect(result).rejects.toThrow('chainHead follow stopped');
    expect(assetHub).toHaveBeenCalledTimes(4);
  });

  it('As a dotli user on a light client, I see a read that fails for any other reason fail without a retry', async () => {
    // Given
    const { dotns } = createResolver([
      { readFails: new RpcError({ code: -32603, message: 'Unknown subscription/token' }) },
    ]);

    // When
    const result = dotns.resolveOwner('alice');

    // Then
    await expect(result).rejects.toThrow('Unknown subscription/token');
    expect(assetHub).toHaveBeenCalledTimes(1);
  });

  it('As a dotli maintainer, I see each Asset Hub client bring-up timed once, with its outcome', async () => {
    // Given: a first client whose chain halts before its first block.
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { dotns } = createResolver([createHaltedBeforeReadyShape()]);

    // When
    await dotns.resolveOwner('alice');

    // Then: the failed bring-up and the one that replaced it.
    const presyncs = metrics.distributions.filter(({ name }) => name === 'dotli.smoldot.presync');
    expect(presyncs.map(({ unit, attributes }) => [unit, attributes])).toEqual([
      ['millisecond', { outcome: 'error' }],
      ['millisecond', { outcome: 'ok' }],
    ]);
  });

  it('As a dotli user on a light client, I give the retry only what is left of the request budget', async () => {
    // Given
    vi.useFakeTimers();
    const { dotns } = createResolver([
      { whenReady: () => rejectAfter(300, new ApiStoppedError()) },
      createNeverReadyShape(),
    ]);

    // When
    let failure: unknown = null;
    dotns.resolveOwner('alice', { syncTimeoutMs: 1_000 }).catch((error: unknown) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(1_000);

    // Then: the halt came at 300 ms and the retry runs on the next timer tick
    expect(failure).toMatchObject({ name: 'NetworkSyncTimeoutError', timeoutMs: 699 });
    expect(assetHub).toHaveBeenCalledTimes(2);
  });

  it('As a dotli user on a light client, I get no retry once a halt comes after my budget is spent', async () => {
    // Given a chain that halts exactly when the request budget runs out
    vi.useFakeTimers();
    const { dotns } = createResolver([{ whenReady: () => rejectAfter(1_000, new ApiStoppedError()) }]);

    // When
    const failure = dotns.resolveOwner('alice', { syncTimeoutMs: 1_000 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_100);

    // Then the read fails on its budget without opening a second client
    await expect(failure).resolves.toMatchObject({ name: 'NetworkSyncTimeoutError', timeoutMs: 1_000 });
    expect(assetHub).toHaveBeenCalledTimes(1);
  });

  it('As a visitor on a gateway whose Asset Hub never syncs, I see each queued read fail within 180 s of its own call', async () => {
    // Given a gateway resolver whose every client never becomes ready
    vi.useFakeTimers();
    const { dotns: gateway, opened } = createResolver(Array.from({ length: 3 }, createNeverReadyShape), 'rpc-gateway');
    const start = Date.now();
    const settledAt: Record<string, number> = {};
    const failures: unknown[] = [];
    function trackFailure(name: string, pending: Promise<unknown>): void {
      pending.catch((error: unknown) => {
        settledAt[name] = Date.now() - start;
        failures.push(error);
      });
    }

    // When the loader reads both manifests, then the name, with no budget of their own
    trackFailure('root', gateway.resolveRootManifest('alice'));
    trackFailure('app', gateway.resolveExecutableManifest('alice', 'app'));
    trackFailure('name', gateway.resolveDotName('alice'));
    await vi.advanceTimersByTimeAsync(180_000);
    const openedWhileWaiting = opened.length;
    await vi.advanceTimersByTimeAsync(3 * 180_000);

    // Then every read fails at the cap, and no client opens once they have all given up
    expect(settledAt).toEqual({ root: 180_000, app: 180_000, name: 180_000 });
    expect(failures).toMatchObject(
      Array(3).fill({ name: 'NetworkSyncTimeoutError', chain: 'Asset Hub RPC', timeoutMs: 180_000 }),
    );
    expect(opened).toHaveLength(openedWhileWaiting);
  });

  it('As the host with a short deadline, I see my read queued behind a slow build fail at my budget and start no build of its own', async () => {
    // Given a first client that fails to sync after 10 s
    vi.useFakeTimers();
    const { dotns, opened } = createResolver([{ whenReady: () => rejectAfter(10_000, new Error('no peers')) }]);
    const presync = dotns.waitForAssetHubFinalized().catch((error: unknown) => error);

    // When a read with a 2 s budget queues behind it
    const short = dotns.resolveOwner('alice', { syncTimeoutMs: 2_000 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    const shortFailure = await short;
    await vi.advanceTimersByTimeAsync(8_000);

    // Then the read failed at its own budget, and the failed build is not followed by one nobody waits for
    expect(shortFailure).toMatchObject({ name: 'NetworkSyncTimeoutError', timeoutMs: 2_000 });
    await expect(presync).resolves.toEqual(new Error('no peers'));
    expect(opened).toHaveLength(1);
  });

  it('As the host, I see my read queued behind a failing build start a build of its own and resolve', async () => {
    // Given a first client that fails to sync after 1 s
    vi.useFakeTimers();
    const { dotns, opened } = createResolver([{ whenReady: () => rejectAfter(1_000, new Error('no peers')) }]);
    const presync = dotns.waitForAssetHubFinalized().catch((error: unknown) => error);

    // When a read with no budget of its own queues behind it
    const owner = dotns.resolveOwner('alice');
    await vi.advanceTimersByTimeAsync(1_000);

    // Then the read gets its answer from a second client
    await expect(owner).resolves.toBeNull();
    await expect(presync).resolves.toEqual(new Error('no peers'));
    expect(opened).toHaveLength(2);
  });

  it('As the host waiting on a name, I get my answer even when my phase callback throws, and each throw is reported', async () => {
    // Given a phase callback that throws on every phase
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const { dotns } = createResolver();

    // When
    const owner = await dotns.resolveOwner('alice', {
      onPhase: () => {
        throw new Error('callback broke');
      },
    });

    // Then
    expect(owner).toBeNull();
    expect(captured).toMatchObject(Array(3).fill({ step: 'listener', tags: { owner: 'resolver.status' } }));
    expect(sentry.counted('listener.delivery')).toEqual(
      Array(3).fill({ outcome: 'error', reason: 'Error', owner: 'resolver.status' }),
    );
  });

  it('As the host waiting on a name after the client is ready, I get my answer even when my phase callback throws on the replayed phase, and the throw is reported', async () => {
    // Given a ready client and a phase callback that throws
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const { dotns } = createResolver();
    await dotns.resolveOwner('alice');

    // When
    const owner = await dotns.resolveOwner('alice', {
      onPhase: () => {
        throw new Error('callback broke');
      },
    });

    // Then
    expect(owner).toBeNull();
    expect(captured).toMatchObject([{ step: 'listener', tags: { owner: 'resolver.status' } }]);
    expect(sentry.counted('listener.delivery')).toEqual([
      { outcome: 'error', reason: 'Error', owner: 'resolver.status' },
    ]);
  });

  it('As the host waiting on a name, I start a resolve from a store listener and hear asset-hub-syncing for both early phases', async () => {
    // Given a store whose listener starts a resolve
    const { dotns } = createResolver();
    const trigger = atom(0);
    const phases: string[] = [];
    let resolving: Promise<string | null> | undefined;
    onTestFinished(
      trigger.listen(() => {
        resolving = dotns.resolveDotName('alice', { onPhase: phase => phases.push(phase) });
      }),
    );

    // When
    trigger.set(1);
    await resolving;

    // Then
    expect(phases).toEqual(['asset-hub-syncing', 'asset-hub-syncing', 'asset-hub-ready', 'resolving-content']);
  });

  it('As the host whose store listener throws as Asset Hub turns ready, I get my answer, the client stays, and the throw is reported', async () => {
    // Given a store the phase callback writes, whose listener throws on asset-hub-ready
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const { dotns, opened } = createResolver();
    const phase = atom<string | null>(null);
    onTestFinished(
      phase.listen(next => {
        if (next === 'asset-hub-ready') {
          throw new Error('listener broke');
        }
      }),
    );

    // When
    const owner = await dotns.resolveOwner('alice', {
      onPhase: next => {
        phase.set(next);
      },
    });

    // Then
    expect(owner).toBeNull();
    expect(must(opened[0], 'first client').destroy).not.toHaveBeenCalled();
    expect(captured).toMatchObject([{ step: 'synced_client_transition' }]);
  });

  it("As the host waiting on a name, I hear the client's phases while it is built, then the content read", async () => {
    // Given
    const { dotns } = createResolver();
    const phases: string[] = [];

    // When
    await dotns.resolveDotName('alice', { onPhase: phase => phases.push(phase) });
    await dotns.resolveDotName('alice', { onPhase: phase => phases.push(phase) });

    // Then
    expect(phases).toEqual([
      'asset-hub-connecting',
      'asset-hub-syncing',
      'asset-hub-ready',
      'resolving-content',
      'asset-hub-ready',
      'resolving-content',
    ]);
  });

  it("As a visitor on a gateway, I resolve names over the host's Asset Hub connection with the same phases, and no light client timings", async () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { dotns: gateway } = createResolver([], 'rpc-gateway');
    const phases: string[] = [];

    // When
    const cid = await gateway.resolveDotName('alice', { onPhase: phase => phases.push(phase) });

    // Then
    expect(cid).toBeNull();
    expect(assetHub).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(['asset-hub-connecting', 'asset-hub-syncing', 'asset-hub-ready', 'resolving-content']);
    expect(metrics.distributions).toEqual([]);
    expect(metrics.measurements).toEqual([]);
  });

  it('As the protocol frame, I warm People twice and open one People client, and a resolver with no People connection skips it', async () => {
    // Given
    const people = vi.fn<() => JsonRpcProvider>(() => () => ({ send: () => undefined, disconnect: () => undefined }));
    const fake = createFakeClients();
    const dotns = getActiveServicesConfig().dotns;
    const withPeople = createDotnsResolver({ assetHub, people, dotns, source: 'light-client', open: fake.open });
    const withoutPeople = createDotnsResolver({ assetHub, dotns, source: 'light-client', open: fake.open });

    // When
    await Promise.all([withPeople.waitForPeopleFinalized(), withPeople.waitForPeopleFinalized()]);
    await withoutPeople.waitForPeopleFinalized();

    // Then
    expect(people).toHaveBeenCalledTimes(1);
    expect(fake.opened).toHaveLength(1);
  });

  it('As the protocol frame, I see my People warm fail as stopped when its follow stops just as it syncs, and the next warm opens a new client', async () => {
    // Given a People client whose follow stops as it reaches its first block
    const people = vi.fn<() => JsonRpcProvider>(() => () => ({ send: () => undefined, disconnect: () => undefined }));
    const { open } = createFakeClients([{ stopsAsReady: true }]);
    const dotns = createDotnsResolver({
      assetHub,
      people,
      dotns: getActiveServicesConfig().dotns,
      source: 'light-client',
      open,
    });

    // When
    const first = await dotns.waitForPeopleFinalized().then(
      () => null,
      (error: unknown) => error,
    );
    await dotns.waitForPeopleFinalized();

    // Then
    expect(first).toBeInstanceOf(ApiStoppedError);
    expect(people).toHaveBeenCalledTimes(2);
  });

  it('As the host whose Asset Hub connection cannot open, I see my read fail with that error, and the next read opens one', async () => {
    // Given
    assetHub.mockImplementationOnce(() => {
      throw new Error('no connection');
    });
    const { dotns } = createResolver();

    // When
    const failure = await dotns.resolveOwner('alice').then(
      () => null,
      (error: unknown) => error,
    );
    const owner = await dotns.resolveOwner('alice');

    // Then
    expect(failure).toEqual(new Error('no connection'));
    expect(owner).toBeNull();
    expect(assetHub).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['a light client that ended', 'AlreadyDestroyedError', 'expected'],
    ['a bug', 'TypeError', 'exceptions'],
  ] as const)(
    'As an operator, I see a chain client whose teardown throws for %s reported and counted under its own step',
    async (_case, name, kind) => {
      // Given an Asset Hub connection that refuses the follow, and whose disconnect throws
      const reports = recordReports({ onFinished: onTestFinished });
      const metrics = bindRecordingSentry({ onFinished: onTestFinished });
      const refusing: JsonRpcProvider = onMessage => ({
        send: request => {
          queueMicrotask(() => {
            onMessage({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32_000, message: 'refused' } });
          });
        },
        disconnect: () => {
          const error = new Error('light client gone');
          error.name = name;
          throw error;
        },
      });
      const dotns = createDotnsResolver({
        assetHub: () => refusing,
        dotns: getActiveServicesConfig().dotns,
        source: 'rpc-gateway',
      });

      // When the build fails and its client is torn down
      await dotns.waitForAssetHubFinalized().catch(() => undefined);

      // Then
      expect(reports[kind]).toMatchObject([{ step: 'client_destroy' }]);
      expect(metrics.counted('resolve.client_destroy')).toEqual([{ outcome: 'error', reason: name }]);
    },
  );
});
