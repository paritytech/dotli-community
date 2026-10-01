// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The seam: `createRawApi` is stubbed (its chainHead follow is covered by the
// api tests), while papi's real `createClient` runs over a fake provider so
// the provider's `disconnect` is observable.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { JsonRpcConnection, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { log } from '@dotli/shared';
import type { Api } from '../src/api.js';

const mocks = vi.hoisted(() => ({
  stops: [] as (() => void)[],
  createRawApi: vi.fn(),
}));

vi.mock('../src/api.js', () => ({ createRawApi: mocks.createRawApi }));

const { destroyResolverClient, resolveOwner, setResolverAssetHubProvider } = await import('../src/resolve.js');

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`missing ${what}`);
  }
  return value;
}

function fakeApi(): Api {
  return {
    whenReady: () => Promise.resolve(),
    destroy: vi.fn<() => void>(),
    onStop: (cb: () => void) => {
      mocks.stops.push(cb);
    },
    readSlot: () => Promise.resolve(null),
  } as unknown as Api;
}

describe('resolve', () => {
  let disconnect: Mock<() => void>;
  let factory: Mock<() => JsonRpcProvider>;
  let warn: Mock<(...args: unknown[]) => void>;

  beforeEach(() => {
    warn = vi.fn<(...args: unknown[]) => void>();
    vi.spyOn(log, 'warn').mockImplementation(warn);
    destroyResolverClient();
    mocks.createRawApi.mockReset().mockImplementation(fakeApi);
    mocks.stops = [];
    disconnect = vi.fn<() => void>();
    factory = vi.fn<() => JsonRpcProvider>(
      () => () => ({ send: vi.fn<JsonRpcConnection['send']>(), disconnect }) satisfies JsonRpcConnection,
    );
  });

  afterEach(() => {
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
});
