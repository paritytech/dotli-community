// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The seam: `createRawApi` is stubbed (its chainHead follow is covered by the
// api tests), while papi's real `createClient` runs over a fake provider so
// the provider's `disconnect` is observable.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { JsonRpcConnection, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { DisjointError, RpcError } from '@polkadot-api/substrate-client';
import { m } from '@dotli/metrics';
import { log } from '@dotli/shared';
import type { Api, ContractStorage } from '../src/api.js';

const mocks = vi.hoisted(() => ({
  stops: [] as (() => void)[],
  createRawApi: vi.fn(),
}));

vi.mock('../src/api.js', () => ({ createRawApi: mocks.createRawApi }));

const {
  destroyResolverClient,
  resolveDotName,
  resolveExecutableManifest,
  resolveOwner,
  resolveRootManifest,
  setResolverAssetHubProvider,
} = await import('../src/resolve.js');

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`missing ${what}`);
  }
  return value;
}

function fakeApi(readSlot: ContractStorage['readSlot'] = () => Promise.resolve(null)): Api {
  return {
    whenReady: () => Promise.resolve(),
    destroy: vi.fn<() => void>(),
    onStop: (cb: () => void) => {
      mocks.stops.push(cb);
      return () => {
        mocks.stops = mocks.stops.filter(stop => stop !== cb);
      };
    },
    withContract: (_address, read) => read({ readSlot }),
  };
}

/** An `ApiStoppedError` as `api.ts` raises it; the module is mocked here. */
function apiStopped(): Error {
  const err = new Error('chainHead follow stopped');
  err.name = 'ApiStoppedError';
  return err;
}

/** A client whose follow never reaches its first block: the chain halted. */
function haltedBeforeReady(): Api {
  return { ...fakeApi(), whenReady: () => Promise.reject(apiStopped()) };
}

/**
 * A client whose read the chain halts under, in the pool's order: the read
 * is answered with `err`, then the follow gets its `stop`.
 */
function haltedMidRead(err: Error): () => Api {
  return () =>
    fakeApi(() => {
      const answer = Promise.reject(err);
      for (const stop of mocks.stops) {
        stop();
      }
      return answer;
    });
}

const RETRY_LOG: unknown = expect.stringMatching(
  /^\[dot\.li resolve\] Chain halted mid-resolution, retrying on a rebuilt chain \(attempt \d\/4\): /,
);

describe('resolve', () => {
  let disconnect: Mock<() => void>;
  let factory: Mock<() => JsonRpcProvider>;
  let warn: Mock<(...args: unknown[]) => void>;

  beforeEach(() => {
    warn = vi.fn<(...args: unknown[]) => void>();
    vi.spyOn(log, 'warn').mockImplementation(warn);
    destroyResolverClient();
    mocks.createRawApi.mockReset().mockImplementation(() => fakeApi());
    mocks.stops = [];
    disconnect = vi.fn<() => void>();
    factory = vi.fn<() => JsonRpcProvider>(
      () => () => ({ send: vi.fn<JsonRpcConnection['send']>(), disconnect }) satisfies JsonRpcConnection,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("As a dotli user on a light client, name resolution takes a fresh Asset Hub lease after the chain's follow stops", async () => {
    // Given
    setResolverAssetHubProvider(factory);
    await resolveOwner('alice');
    await resolveOwner('alice');
    expect(factory).toHaveBeenCalledTimes(1);

    // When
    must(mocks.stops[0], 'stop callback')();
    await resolveOwner('alice');

    // Then
    expect(factory).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[dot.li resolve] chainHead follow stopped, invalidating resolver client');
  });

  it.each([
    [
      'the halted answer to a read in flight',
      new RpcError({ code: -32603, message: 'Chain transport halted', data: 'dotli:chain-halted' }),
    ],
    ['a read cut off by the stop', new DisjointError()],
    ['a read after the stop', apiStopped()],
  ])('As a dotli user on a light client, a name still resolves when its chain halts under %s', async (_case, err) => {
    // Given
    setResolverAssetHubProvider(factory);
    mocks.createRawApi.mockImplementationOnce(haltedMidRead(err));

    // When
    const owner = await resolveOwner('alice');

    // Then
    expect(owner).toBeNull();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('[dot.li resolve] chainHead follow stopped, invalidating resolver client');
    expect(warn).toHaveBeenCalledWith(RETRY_LOG, expect.anything());
  });

  it.each([
    ['resolveDotName', () => resolveDotName('alice')],
    ['resolveExecutableManifest', () => resolveExecutableManifest('alice', 'app')],
    ['resolveOwner', () => resolveOwner('alice')],
    ['resolveRootManifest', () => resolveRootManifest('alice')],
  ])(
    'As a dotli user on a light client, %s survives a chain that halts before its first block',
    async (_name, read) => {
      // Given
      setResolverAssetHubProvider(factory);
      mocks.createRawApi.mockImplementationOnce(haltedBeforeReady);

      // When
      await read();

      // Then
      expect(factory).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(RETRY_LOG, expect.anything());
    },
  );

  it('As a dotli user on a light client resuming from a recent stored database, a name still resolves when smoldot resets the chain twice while catching up', async () => {
    // Given
    setResolverAssetHubProvider(factory);
    mocks.createRawApi
      .mockImplementationOnce(haltedMidRead(new DisjointError()))
      .mockImplementationOnce(haltedMidRead(new DisjointError()));

    // When
    const owner = await resolveOwner('alice');

    // Then
    expect(owner).toBeNull();
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it('As a dotli user on a light client, a chain that keeps halting fails the resolution after four attempts', async () => {
    // Given
    setResolverAssetHubProvider(factory);
    mocks.createRawApi.mockImplementation(haltedBeforeReady);

    // When
    const result = resolveOwner('alice');

    // Then
    await expect(result).rejects.toMatchObject({ name: 'ApiStoppedError' });
    expect(factory).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls.filter(([line]) => String(line).includes('retrying on a rebuilt chain'))).toHaveLength(3);
  });

  it('As a dotli user on a light client, a read that fails for any other reason is not retried', async () => {
    // Given
    setResolverAssetHubProvider(factory);
    const failure = new RpcError({ code: -32603, message: 'Unknown subscription/token' });
    mocks.createRawApi.mockImplementationOnce(() => fakeApi(() => Promise.reject(failure)));

    // When
    const result = resolveOwner('alice');

    // Then
    await expect(result).rejects.toBe(failure);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalledWith(RETRY_LOG, expect.anything());
  });

  it('As a dotli maintainer, each Asset Hub client bring-up is timed once, with its outcome', async () => {
    // Given: a first client whose chain halts before its first block.
    const distribution = vi.spyOn(m, 'distribution');
    setResolverAssetHubProvider(factory);
    mocks.createRawApi.mockImplementationOnce(haltedBeforeReady);

    // When
    await resolveOwner('alice');

    // Then: the failed bring-up and the one that replaced it.
    const presyncs = distribution.mock.calls.filter(([name]) => name === 'smoldot.presync');
    expect(presyncs.map(([, , unit, attrs]) => [unit, attrs])).toEqual([
      ['millisecond', { outcome: 'error' }],
      ['millisecond', { outcome: 'ok' }],
    ]);
  });

  it('As a dotli user on a light client, the retry only gets what is left of the request budget', async () => {
    // Given
    vi.useFakeTimers();
    setResolverAssetHubProvider(factory);
    mocks.createRawApi
      .mockImplementationOnce(() => ({
        ...fakeApi(),
        whenReady: () =>
          new Promise<void>((_resolve, reject) => {
            setTimeout(() => {
              reject(apiStopped());
            }, 300);
          }),
      }))
      .mockImplementationOnce(() => ({ ...fakeApi(), whenReady: () => new Promise<void>(() => undefined) }));

    // When
    let failure: unknown = null;
    resolveOwner('alice', { syncTimeoutMs: 1_000 }).catch((err: unknown) => {
      failure = err;
    });
    await vi.advanceTimersByTimeAsync(1_000);

    // Then
    expect(failure).toMatchObject({ name: 'NetworkSyncTimeoutError', timeoutMs: 700 });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(RETRY_LOG, expect.anything());
  });
});
