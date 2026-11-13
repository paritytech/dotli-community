// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import type { JsonRpcMessage } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig, getSettings, setSettings } from '@dotli/config';
import { fromHex } from '@dotli/shared';
import { must } from '@dotli/shared/testing';
import { createChainConnect } from './createChainConnect.js';
import { createHostChainPool } from './createHostChainPool.js';
import {
  createFakeHostChainSources,
  createFakeRemoteChains,
  type FakeHostChainSources,
  type FakeRemoteChains,
} from './createHostChainPool.fake.js';
import { getHostAssetHubProvider, getHostChainProvider } from './getHostChainProvider.js';

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
    onTestFinished(setSettings({ ...getSettings(), backend: 'smoldot-direct' }));
    people = getActiveServicesConfig().people.genesis;
    chains = createFakeRemoteChains();
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
});
