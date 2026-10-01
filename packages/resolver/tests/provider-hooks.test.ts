// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { getActiveServicesConfig } from '@dotli/config';
import type { ChainTransportHooks } from '../src/transport-hooks.js';

// A truapi-provider connection whose response stream the test drives.
interface FakeConnection {
  send: (raw: string) => void;
  close: () => void;
  nextResponse: () => Promise<string | undefined>;
  /** End the stream as a dead transport would, without `close()`. */
  end: () => void;
}

const truapi = vi.hoisted(() => {
  const state: {
    connect: (genesisHash: string) => Promise<FakeConnection>;
    connections: FakeConnection[];
  } = {
    connect: () => Promise.reject(new Error('no connection')),
    connections: [],
  };
  return state;
});

function createConnection(): FakeConnection {
  const queued: (string | undefined)[] = [];
  let wake: ((value: string | undefined) => void) | null = null;
  const push = (value: string | undefined): void => {
    if (wake !== null) {
      const resolve = wake;
      wake = null;
      resolve(value);
      return;
    }
    queued.push(value);
  };
  return {
    send: () => undefined,
    close: () => {
      push(undefined);
    },
    nextResponse: () =>
      new Promise(resolve => {
        if (queued.length > 0) {
          resolve(queued.shift());
          return;
        }
        wake = resolve;
      }),
    end: () => {
      push(undefined);
    },
  };
}

vi.mock('@parity/truapi-provider', () => ({
  default: () => Promise.resolve(),
  setLogLevel: () => undefined,
  ChainProviderBuilder: class {
    setConnectionTypes(): void {
      /* the fake dials nothing */
    }
    setStorage(): void {
      /* no store in this test */
    }
    build(): unknown {
      return {
        loadDatabase: () => Promise.resolve(false),
        connect: (genesisHash: string) => truapi.connect(genesisHash),
        lifecycle: () => undefined,
      };
    }
  },
}));

vi.mock('../src/smoldot-db.js', () => ({ createSmoldotDb: () => null }));

vi.mock('../src/chain-sync.js', () => ({
  attachChainSync: () => ({ intercept: () => false, stop: () => undefined }),
  chainKeyForGenesis: () => null,
  reportDbCache: () => undefined,
}));

vi.mock('../../metrics/src/metrics.js', () => ({
  m: { enabled: false, gauge: () => undefined },
}));

const { createChainProvider } = await import('../src/provider.js');

interface MockHooks {
  onStatus: Mock<ChainTransportHooks['onStatus']>;
  onHalt: Mock<ChainTransportHooks['onHalt']>;
}

function hooks(): MockHooks {
  return { onStatus: vi.fn<ChainTransportHooks['onStatus']>(), onHalt: vi.fn<ChainTransportHooks['onHalt']>() };
}

function open(
  genesisHash: string,
  chainHooks: MockHooks,
): ReturnType<NonNullable<ReturnType<typeof createChainProvider>>> {
  const provider = createChainProvider(genesisHash, chainHooks);
  if (provider === null) {
    throw new Error(`no provider for ${genesisHash}`);
  }
  return provider(() => undefined);
}

describe('smoldot chain provider hooks', () => {
  const people = getActiveServicesConfig().people.genesis;

  beforeEach(() => {
    truapi.connections = [];
    truapi.connect = () => {
      const connection = createConnection();
      truapi.connections.push(connection);
      return Promise.resolve(connection);
    };
  });

  it('As a dotli integrator, a light-client connection reports connecting, then connected', async () => {
    // Given
    const chainHooks = hooks();

    // When
    open(people, chainHooks);

    // Then
    expect(chainHooks.onStatus).toHaveBeenCalledWith('connecting');
    await vi.waitFor(() => {
      expect(chainHooks.onStatus).toHaveBeenLastCalledWith('connected');
    });
    expect(chainHooks.onHalt).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, a light-client stream that ends on its own halts the transport', async () => {
    // Given
    const chainHooks = hooks();
    open(people, chainHooks);
    await vi.waitFor(() => {
      expect(chainHooks.onStatus).toHaveBeenLastCalledWith('connected');
    });

    // When
    truapi.connections[0]?.end();

    // Then
    await vi.waitFor(() => {
      expect(chainHooks.onHalt).toHaveBeenCalledTimes(1);
    });
    expect(chainHooks.onStatus).toHaveBeenLastCalledWith('disconnected');
  });

  it('As a dotli integrator, a halt listener that throws on the end of the stream is called once', async () => {
    // Given
    const chainHooks = hooks();
    chainHooks.onHalt.mockImplementation(() => {
      throw new Error('listener failed');
    });
    open(people, chainHooks);
    await vi.waitFor(() => {
      expect(chainHooks.onStatus).toHaveBeenLastCalledWith('connected');
    });

    // When
    truapi.connections[0]?.end();
    await vi.waitFor(() => {
      expect(chainHooks.onHalt).toHaveBeenCalled();
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    // Then
    expect(chainHooks.onHalt).toHaveBeenCalledTimes(1);
  });

  it('As a dotli integrator, a light-client connection closed by its owner does not halt', async () => {
    // Given
    const chainHooks = hooks();
    const connection = open(people, chainHooks);
    await vi.waitFor(() => {
      expect(chainHooks.onStatus).toHaveBeenLastCalledWith('connected');
    });

    // When
    connection.disconnect();
    await new Promise(resolve => setTimeout(resolve, 0));

    // Then
    expect(chainHooks.onHalt).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, a light-client connection that cannot connect halts with the cause', async () => {
    // Given
    const failure = new Error('catalog has no such chain');
    truapi.connect = () => Promise.reject(failure);
    const chainHooks = hooks();

    // When
    open(people, chainHooks);

    // Then
    await vi.waitFor(() => {
      expect(chainHooks.onHalt).toHaveBeenCalledWith(failure);
    });
    expect(chainHooks.onStatus).toHaveBeenLastCalledWith('disconnected');
  });
});
