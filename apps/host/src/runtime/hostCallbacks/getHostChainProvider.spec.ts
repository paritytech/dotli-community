// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig, getSettings, setSettings } from '@dotli/config';
import type { ChainActivity } from '@dotli/chains';
import { FakeWebSocket } from '@dotli/chains/testing';
import { fromHex } from '@dotli/shared';
import { must } from '@dotli/shared/testing';
import { createChainConnect } from './createChainConnect.js';
import { createHostChainPool } from './createHostChainPool.js';
import {
  createFakeHostChainSources,
  createFakeRemoteChains,
  createFakeSocketChain,
  type FakeHostChainSources,
  type FakeRemoteChains,
} from './createHostChainPool.fake.js';
import { getHostAssetHubProvider, getHostChainProvider } from './getHostChainProvider.js';
import { watchHostChains } from './watchHostChains.js';

describe('host Asset Hub provider', () => {
  let assetHub: string;
  let sources: FakeHostChainSources;

  beforeEach(() => {
    assetHub = getActiveServicesConfig().assethub.genesis;
    sources = createFakeHostChainSources();
  });

  it("As a dotli user on Trusted Providers, I resolve names twice and both lease the pool's one Asset Hub transport", () => {
    // Given
    sources.setBackend('rpc-gateway');
    const pool = createHostChainPool({ ...sources, destroyDelay: 0 });
    const received: JsonRpcMessage[] = [];

    // When
    const first = getHostAssetHubProvider({ pool })(message => received.push(message));
    const second = getHostAssetHubProvider({ pool })(message => received.push(message));
    onTestFinished(() => {
      first.disconnect();
      second.disconnect();
    });

    // Then
    expect(sources.createRpcChain).toHaveBeenCalledWith(assetHub.toLowerCase(), expect.any(Object));
    expect(sources.upstreams).toHaveLength(1);
    expect(must(sources.upstreams[0], 'upstream').opened).toBe(1);
  });
});

// The host page's chain pool end to end (chain, pool, broker, backend transport), with remote connections faked.

describe('host chain pool on a light client backend', () => {
  let people: string;
  let chains: FakeRemoteChains;

  beforeEach(() => {
    vi.useFakeTimers();
    // Registered first, so it runs after every cleanup a test registers.
    onTestFinished(() => {
      vi.useRealTimers();
    });
    onTestFinished(setSettings({ ...getSettings(), backend: 'smoldot-direct' }));
    people = getActiveServicesConfig().people.genesis;
    chains = createFakeRemoteChains();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("As a user, I open a block bar and it shares the products' connection to the protocol frame", async () => {
    // Given
    const pool = createHostChainPool({ createRemoteChain: chains.createRemoteChain, frame: chains.frame });
    const connect = createChainConnect({ pool });
    const first = await connect(fromHex(people));
    const second = await connect(fromHex(people));
    onTestFinished(() => {
      first.close();
      second.close();
    });

    // When
    const bar = must(getHostChainProvider(people, { pool }), 'provider')(() => undefined);
    onTestFinished(() => {
      bar.disconnect();
    });

    // Then
    expect(chains.createRemoteChain).toHaveBeenCalledTimes(1);
    expect(chains.remotes).toHaveLength(1);
  });

  it.each(['chain', 'frame'] as const)(
    "As the host page, my read's chain halts for %s and my next request goes on the rebuilt chain",
    async reason => {
      // Given
      const pool = createHostChainPool({ createRemoteChain: chains.createRemoteChain, frame: chains.frame });
      const product = await createChainConnect({ pool })(fromHex(people));
      onTestFinished(() => {
        product.close();
      });
      const read = must(getHostChainProvider(people, { pool }), 'provider')(() => undefined);
      onTestFinished(() => {
        read.disconnect();
      });
      must(chains.remotes[0], 'remote').halt(reason);

      // When
      read.send({ jsonrpc: '2.0', id: 'read:1', method: 'chainSpec_v1_genesisHash', params: [] });

      // Then
      expect(chains.remotes).toHaveLength(2);
      expect(must(chains.remotes[1], 'rebuilt remote').sent).toHaveLength(1);
    },
  );

  it('As a user, I ask for a chain the protocol frame cannot serve and get no host provider', () => {
    // Given a light client backend with no connection to the frame open

    // When
    const provider = getHostChainProvider(`0x${'00'.repeat(32)}`, {
      pool: createHostChainPool({ createRemoteChain: chains.createRemoteChain }),
    });

    // Then
    expect(provider).toBeNull();
    expect(chains.createRemoteChain).not.toHaveBeenCalled();
  });

  it('As a user, I open a block bar after a halt and it opens a fresh connection to the frame', () => {
    // Given
    const pool = createHostChainPool({ createRemoteChain: chains.createRemoteChain });
    const provider = must(getHostChainProvider(people, { pool }), 'provider');
    provider(() => undefined);
    must(chains.remotes[0], 'first remote').halt('chain');

    // When
    const bar = provider(() => undefined);
    onTestFinished(() => {
      bar.disconnect();
    });
    bar.send({ jsonrpc: '2.0', id: 'bar:1', method: 'chainSpec_v1_genesisHash', params: [] });

    // Then
    expect(chains.remotes).toHaveLength(2);
    expect(must(chains.remotes[1], 'second remote').sent).toHaveLength(1);
  });

  it('As a user with the network panel open, I lease a chain on the host pool and the panel reports it held without holding it', () => {
    // Given a pool the panel watches, as the page's is
    const reported: ChainActivity[] = [];
    const pool = createHostChainPool({ createRemoteChain: chains.createRemoteChain });
    watchHostChains({ onActivity: activity => reported.push(activity), onBestBlock: () => undefined }, { pool });
    const readConsumers = (): number | undefined =>
      reported.findLast(activity => activity.genesisHash === people.toLowerCase())?.consumers;
    const beforeTheLease = readConsumers();

    // When the chain is leased, then released
    const connection = must(getHostChainProvider(people, { pool }), 'provider')(() => undefined);
    const whileLeased = readConsumers();
    connection.disconnect();
    const afterTheRelease = readConsumers();

    // Then
    expect([beforeTheLease, whileLeased, afterTheRelease]).toEqual([undefined, 1, 0]);
  });
});

describe('host chain pool over Trusted Providers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Registered first, so it runs after every cleanup a test registers.
    onTestFinished(() => {
      vi.useRealTimers();
    });
    FakeWebSocket.instances = [];
    onTestFinished(setSettings({ ...getSettings(), backend: 'rpc-gateway' }));
  });

  it('As a dotli user on Trusted Providers, I use a block bar beside a product and their connections share one socket', async () => {
    // Given
    const people = getActiveServicesConfig().people.genesis;
    const pool = createHostChainPool({ createRpcChain: createFakeSocketChain });
    const product = await createChainConnect({ pool })(fromHex(people));
    const bar = must(getHostChainProvider(people, { pool }), 'provider')(() => undefined);
    onTestFinished(() => {
      product.close();
      bar.disconnect();
    });

    // When
    product.send(JSON.stringify({ jsonrpc: '2.0', id: 'truapi:1', method: 'chainSpec_v1_chainName', params: [] }));
    bar.send({ jsonrpc: '2.0', id: 'bar:1', method: 'chainSpec_v1_genesisHash', params: [] });
    await vi.advanceTimersByTimeAsync(0);
    must(FakeWebSocket.instances[0], 'socket').open();

    // Then
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = must(FakeWebSocket.instances[0], 'socket');
    expect(socket.requests('chainSpec_v1_chainName')).toHaveLength(1);
    expect(socket.requests('chainSpec_v1_genesisHash')).toHaveLength(1);
  });
});
