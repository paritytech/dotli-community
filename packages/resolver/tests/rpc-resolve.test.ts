// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The seam: `createRawApi` is stubbed (its chainHead follow is covered by the
// api tests), while papi's real `createClient` runs over a fake provider so
// the provider's `disconnect` is observable.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { JsonRpcConnection, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig } from '@dotli/config';
import { log } from '@dotli/shared';
import type { Api } from '../src/api.js';

const mocks = vi.hoisted(() => ({
  stops: [] as (() => void)[],
  createRawApi: vi.fn(),
  getConnectedRpcEndpoint: vi.fn(),
}));

vi.mock('../src/api.js', () => ({ createRawApi: mocks.createRawApi }));
vi.mock('../src/rpc-chain.js', () => ({ getConnectedRpcEndpoint: mocks.getConnectedRpcEndpoint }));

const { getConnectedAssetHubRpcEndpoint, destroyRpcClient, resolveOwnerViaRpc, setRpcAssetHubProvider } =
  await import('../src/rpc-resolve.js');

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

describe('rpc-resolve', () => {
  let disconnect: Mock<() => void>;
  let factory: Mock<() => JsonRpcProvider>;
  let warn: Mock<(...args: unknown[]) => void>;
  let event: Mock<(name: string, attrs?: Record<string, unknown>) => void>;

  beforeEach(() => {
    warn = vi.fn<(...args: unknown[]) => void>();
    event = vi.fn<(name: string, attrs?: Record<string, unknown>) => void>();
    vi.spyOn(log, 'warn').mockImplementation(warn);
    vi.spyOn(log, 'event').mockImplementation(event);
    destroyRpcClient();
    vi.clearAllMocks();
    mocks.stops = [];
    disconnect = vi.fn<() => void>();
    factory = vi.fn<() => JsonRpcProvider>(
      () => () => ({ send: vi.fn<JsonRpcConnection['send']>(), disconnect }) satisfies JsonRpcConnection,
    );
    mocks.createRawApi.mockImplementation(fakeApi);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('As a dotli user, resolving without an Asset Hub provider fails with a named error', async () => {
    // Given
    vi.resetModules();
    const fresh = await import('../src/rpc-resolve.js');

    // When
    const result = fresh.resolveOwnerViaRpc('alice');

    // Then
    await expect(result).rejects.toThrow('No Asset Hub provider for RPC resolution');
  });

  it('As a dotli user, the client is built on the injected provider and redialed after the follow stops', async () => {
    // Given
    setRpcAssetHubProvider(factory);
    await resolveOwnerViaRpc('alice');
    await resolveOwnerViaRpc('alice');
    expect(factory).toHaveBeenCalledTimes(1);

    // When
    must(mocks.stops[0], 'stop callback')();
    await resolveOwnerViaRpc('alice');

    // Then
    expect(factory).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[dot.li rpc-resolve] chainHead follow stopped, invalidating RPC client');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, destroying the RPC client releases the provider and the next resolve takes a new one', async () => {
    // Given
    setRpcAssetHubProvider(factory);
    await resolveOwnerViaRpc('alice');

    // When
    destroyRpcClient();
    await resolveOwnerViaRpc('alice');

    // Then
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(event).toHaveBeenCalledWith('RPC chain head ready', expect.objectContaining({ flow: 'resolve' }));
    expect(event.mock.calls.filter(([name]) => name === 'RPC chain head ready')).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('As a dotli user, the diagnostics endpoint is the one Asset Hub is connected on', () => {
    // Given
    mocks.getConnectedRpcEndpoint.mockReturnValue('wss://asset-hub.example');

    // When
    const endpoint = getConnectedAssetHubRpcEndpoint();

    // Then
    expect(endpoint).toBe('wss://asset-hub.example');
    expect(mocks.getConnectedRpcEndpoint).toHaveBeenCalledWith(getActiveServicesConfig().assethub.genesis);
  });
});
