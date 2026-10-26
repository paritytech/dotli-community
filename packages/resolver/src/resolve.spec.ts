// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The chain client is passed in through `open`, so each test hands the resolver fake reads and halts.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { must } from '@dotli/shared/testing';
import type { JsonRpcConnection, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { DisjointError, RpcError } from '@polkadot-api/substrate-client';
import { getActiveServicesConfig } from '@dotli/config';
import { bindLogSink } from '@dotli/shared';
import type { Api } from './api.js';
import { createDotnsResolver, type ChainClient, type DotnsResolver } from './resolve.js';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';

/** A chain client whose follow can be stopped from the test. */
type FakeClient = {
  stop: () => void;
  destroy: Mock<() => void>;
} & ChainClient;

/** How one client behaves: its sync, and what a slot read answers. */
type ApiShape = {
  whenReady?: () => Promise<void>;
  /** Every slot read rejects with this. */
  readFails?: Error;
  /** The chain halts under the read, in the pool's order: the read is answered first, then the follow stops. */
  haltsOnRead?: boolean;
};

function apiStopped(): Error {
  const err = new Error('chainHead follow stopped');
  err.name = 'ApiStoppedError';
  return err;
}

/** Hands out clients in order, each shaped by the next entry, and plain ones once the list runs out. */
function clients(shapes: ApiShape[] = []): { open: (provider: JsonRpcProvider) => FakeClient; opened: FakeClient[] } {
  const opened: FakeClient[] = [];
  const open = (provider: JsonRpcProvider): FakeClient => {
    const shape = shapes.shift() ?? {};
    // Connected as papi's client would, so the test sees each lease taken and released.
    const connection = provider(() => undefined);
    const stops: (() => void)[] = [];
    const stop = (): void => {
      for (const callback of stops.splice(0)) {
        callback();
      }
    };
    const api = {
      whenReady: shape.whenReady ?? (() => Promise.resolve()),
      withBestBlock: <T>(read: (hash: string) => Promise<T>) => read('0x01'),
      resolveTrieId: () => Promise.resolve(null),
      readSlot: () => {
        const answer = shape.readFails === undefined ? Promise.resolve(null) : Promise.reject(shape.readFails);
        if (shape.haltsOnRead === true) {
          stop();
        }
        return answer;
      },
      onStop: (callback: () => void) => {
        stops.push(callback);
        return () => undefined;
      },
      destroy: () => undefined,
    } as unknown as Api;
    const client: FakeClient = {
      api,
      stop,
      destroy: vi.fn(() => {
        connection.disconnect();
      }),
    };
    opened.push(client);
    return client;
  };
  return { open, opened };
}

/** A client whose follow never reaches its first block: the chain halted. */
const haltedBeforeReady = (): ApiShape => ({ whenReady: () => Promise.reject(apiStopped()) });

/** A client with no reachable peers, whose follow never reaches its first block. */
const neverReady = (): ApiShape => ({ whenReady: () => new Promise<void>(() => undefined) });

function rejectAfter(ms: number, err: Error): Promise<void> {
  return new Promise<void>((_resolve, reject) => {
    setTimeout(() => {
      reject(err);
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

  function resolver(shapes: ApiShape[] = []): { dotns: DotnsResolver; opened: FakeClient[] } {
    const { open, opened } = clients(shapes);
    return {
      dotns: createDotnsResolver({ assetHub, dotns: getActiveServicesConfig().dotns, source: 'light-client', open }),
      opened,
    };
  }

  it("As a dotli user on a light client, I resolve names on a fresh Asset Hub lease after the chain's follow stops", async () => {
    // Given
    const { dotns, opened } = resolver();
    await dotns.resolveOwner('alice');
    await dotns.resolveOwner('alice');
    expect(assetHub).toHaveBeenCalledTimes(1);

    // When
    must(opened[0], 'first client').stop();
    await dotns.resolveOwner('alice');

    // Then
    expect(assetHub).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('As the host on a cold start, I make three concurrent reads and they share one Asset Hub client', async () => {
    // Given
    const { dotns } = resolver();

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
    ['a read after the stop', apiStopped()],
  ])('As a dotli user on a light client, I still resolve a name when its chain halts under %s', async (_case, err) => {
    // Given
    const { dotns } = resolver([{ readFails: err, haltsOnRead: true }]);

    // When
    const owner = await dotns.resolveOwner('alice');

    // Then
    expect(owner).toBeNull();
    expect(assetHub).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['resolveDotName', (dotns: DotnsResolver) => dotns.resolveDotName('alice')],
    ['resolveExecutableManifest', (dotns: DotnsResolver) => dotns.resolveExecutableManifest('alice', 'app')],
    ['resolveOwner', (dotns: DotnsResolver) => dotns.resolveOwner('alice')],
    ['resolveRootManifest', (dotns: DotnsResolver) => dotns.resolveRootManifest('alice')],
  ])(
    'As a dotli user on a light client, I call %s and it survives a chain that halts before its first block',
    async (_name, read) => {
      // Given
      const { dotns } = resolver([haltedBeforeReady()]);

      // When
      await read(dotns);

      // Then
      expect(assetHub).toHaveBeenCalledTimes(2);
    },
  );

  it('As a dotli user on a light client resuming from a recent stored database, I still resolve a name when smoldot resets the chain twice while catching up', async () => {
    // Given
    const { dotns } = resolver([
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
    const { dotns } = resolver(Array.from({ length: 6 }, haltedBeforeReady));

    // When
    const result = dotns.resolveOwner('alice');

    // Then
    await expect(result).rejects.toThrow('chainHead follow stopped');
    expect(assetHub).toHaveBeenCalledTimes(4);
  });

  it('As a dotli user on a light client, I see a read that fails for any other reason fail without a retry', async () => {
    // Given
    const { dotns } = resolver([{ readFails: new RpcError({ code: -32603, message: 'Unknown subscription/token' }) }]);

    // When
    const result = dotns.resolveOwner('alice');

    // Then
    await expect(result).rejects.toThrow('Unknown subscription/token');
    expect(assetHub).toHaveBeenCalledTimes(1);
  });

  it('As a dotli maintainer, I see each Asset Hub client bring-up timed once, with its outcome', async () => {
    // Given: a first client whose chain halts before its first block.
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { dotns } = resolver([haltedBeforeReady()]);

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
    const { dotns } = resolver([
      {
        whenReady: () =>
          new Promise<void>((_resolve, reject) => {
            setTimeout(() => {
              reject(apiStopped());
            }, 300);
          }),
      },
      { whenReady: () => new Promise<void>(() => undefined) },
    ]);

    // When
    let failure: unknown = null;
    dotns.resolveOwner('alice', { syncTimeoutMs: 1_000 }).catch((err: unknown) => {
      failure = err;
    });
    await vi.advanceTimersByTimeAsync(1_000);

    // Then: the halt came at 300 ms and the retry runs on the next timer tick
    expect(failure).toMatchObject({ name: 'NetworkSyncTimeoutError', timeoutMs: 699 });
    expect(assetHub).toHaveBeenCalledTimes(2);
  });

  it('As a dotli user on a light client, I get no retry once a halt comes after my budget is spent', async () => {
    // Given a chain that halts exactly when the request budget runs out
    vi.useFakeTimers();
    const { dotns } = resolver([{ whenReady: () => rejectAfter(1_000, apiStopped()) }]);

    // When
    const failure = dotns.resolveOwner('alice', { syncTimeoutMs: 1_000 }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(1_100);

    // Then the read fails on its budget without opening a second client
    await expect(failure).resolves.toMatchObject({ name: 'NetworkSyncTimeoutError', timeoutMs: 1_000 });
    expect(assetHub).toHaveBeenCalledTimes(1);
  });

  it('As a visitor on a gateway whose Asset Hub never syncs, I see each queued read fail within 180 s of its own call', async () => {
    // Given a gateway resolver whose every client never becomes ready
    vi.useFakeTimers();
    const { open, opened } = clients(Array.from({ length: 3 }, neverReady));
    const gateway = createDotnsResolver({
      assetHub,
      dotns: getActiveServicesConfig().dotns,
      source: 'rpc-gateway',
      open,
    });
    const start = Date.now();
    const settledAt: Record<string, number> = {};
    const failures: unknown[] = [];
    const track = (name: string, pending: Promise<unknown>): void => {
      pending.catch((err: unknown) => {
        settledAt[name] = Date.now() - start;
        failures.push(err);
      });
    };

    // When the loader reads both manifests, then the name, with no budget of their own
    track('root', gateway.resolveRootManifest('alice'));
    track('app', gateway.resolveExecutableManifest('alice', 'app'));
    track('name', gateway.resolveDotName('alice'));
    await vi.advanceTimersByTimeAsync(180_000);
    const openedWhileWaiting = opened.length;
    await vi.advanceTimersByTimeAsync(3 * 180_000);

    // Then every read fails at the cap, and no client opens once they have all given up
    expect(settledAt).toEqual({ root: 180_000, app: 180_000, name: 180_000 });
    for (const failure of failures) {
      expect(failure).toMatchObject({ name: 'NetworkSyncTimeoutError', chain: 'Asset Hub RPC', timeoutMs: 180_000 });
    }
    expect(opened).toHaveLength(openedWhileWaiting);
  });

  it('As the host with a short deadline, I see my read queued behind a slow build fail at my budget and start no build of its own', async () => {
    // Given a first client that fails to sync after 10 s
    vi.useFakeTimers();
    const { dotns, opened } = resolver([{ whenReady: () => rejectAfter(10_000, new Error('no peers')) }]);
    const presync = dotns.waitForAssetHubFinalized().catch((err: unknown) => err);

    // When a read with a 2 s budget queues behind it
    const short = dotns.resolveOwner('alice', { syncTimeoutMs: 2_000 }).catch((err: unknown) => err);
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
    const { dotns, opened } = resolver([{ whenReady: () => rejectAfter(1_000, new Error('no peers')) }]);
    const presync = dotns.waitForAssetHubFinalized().catch((err: unknown) => err);

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
    const captured = recordCaptures({ onFinished: onTestFinished });
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const { dotns } = resolver();

    // When
    const owner = await dotns.resolveOwner('alice', {
      onPhase: () => {
        throw new Error('callback broke');
      },
    });

    // Then
    expect(owner).toBeNull();
    expect(captured).toEqual(Array(3).fill({ flow: 'resolve', step: 'listener', tags: { owner: 'resolver.status' } }));
    expect(sentry.counted('listener.delivery')).toEqual(
      Array(3).fill({ outcome: 'error', reason: 'Error', owner: 'resolver.status' }),
    );
  });

  it('As the protocol worker, I see the presync fail when Asset Hub never syncs, and the next read tries again', async () => {
    // Given
    const { dotns } = resolver([{ whenReady: () => Promise.reject(new Error('no peers')) }]);

    // When
    const presync = await dotns.waitForAssetHubFinalized().catch((err: unknown) => err);
    const owner = await dotns.resolveOwner('alice');

    // Then
    expect(presync).toEqual(new Error('no peers'));
    expect(owner).toBeNull();
    expect(assetHub).toHaveBeenCalledTimes(2);
  });

  it('As a second product resolving after Asset Hub synced, I hear asset-hub-ready before my name resolves', async () => {
    // Given
    const { dotns } = resolver();
    await dotns.resolveDotName('alice');
    const phases: string[] = [];

    // When
    await dotns.resolveDotName('alice', { onPhase: phase => phases.push(phase) });

    // Then
    expect(phases).toEqual(['asset-hub-ready', 'resolving-content']);
  });

  it("As the host waiting on a name, I hear the client's phases while it is built, then the content read", async () => {
    // Given
    const { dotns } = resolver();
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
    const { open } = clients();
    const gateway = createDotnsResolver({
      assetHub,
      dotns: getActiveServicesConfig().dotns,
      source: 'rpc-gateway',
      open,
    });
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

  it('As a visitor on a gateway, I still resolve a name when the host pool halts the Asset Hub connection under the read', async () => {
    // Given
    const { open } = clients([
      {
        readFails: new RpcError({ code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' }),
        haltsOnRead: true,
      },
    ]);
    const gateway = createDotnsResolver({
      assetHub,
      dotns: getActiveServicesConfig().dotns,
      source: 'rpc-gateway',
      open,
    });

    // When
    const owner = await gateway.resolveOwner('alice');

    // Then
    expect(owner).toBeNull();
    expect(assetHub).toHaveBeenCalledTimes(2);
  });

  it('As the protocol frame, I warm People twice and open one People client, and a resolver with no People connection skips it', async () => {
    // Given
    const people = vi.fn<() => JsonRpcProvider>(() => () => ({ send: () => undefined, disconnect: () => undefined }));
    const fake = clients();
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
});
