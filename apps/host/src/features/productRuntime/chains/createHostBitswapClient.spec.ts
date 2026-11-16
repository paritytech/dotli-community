// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { JsonRpcId } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig, getSettings, setSettings } from '@dotli/config';
import { must } from '@dotli/shared/testing';
import { createHostBitswapClient } from './createHostBitswapClient.js';
import { createHostChainPool } from './createHostChainPool.js';
import { createFakeRemoteChains, type FakeRemoteChains, type RemoteConnection } from './createHostChainPool.fake.js';

// The follow a watched pool opens shares the connection, so a request is picked by its method.
async function answerGet(remote: RemoteConnection, hex: string): Promise<void> {
  const id = await vi.waitFor((): JsonRpcId =>
    must(remote.sent.find(sent => sent.method === 'bitswap_v1_get')?.id, 'a bitswap_v1_get'),
  );
  remote.emit({ jsonrpc: '2.0', id, result: hex });
}

describe('host bitswap client', () => {
  let bulletin: string;
  let chains: FakeRemoteChains;

  beforeEach(() => {
    onTestFinished(setSettings({ ...getSettings(), backend: 'smoldot-direct' }));
    bulletin = getActiveServicesConfig().bulletin.genesis;
    chains = createFakeRemoteChains();
  });

  it("As a host page, I fetch a block and it goes over the pool's one connection to Bulletin", async () => {
    // Given
    const pool = createHostChainPool({ createRemoteChain: chains.createRemoteChain, destroyDelay: 0 });
    const client = createHostBitswapClient({ pool });

    // When
    const block = client.get('bafyTest');
    const remote = await vi.waitFor(() => must(chains.remotes[0], 'remote'));
    await answerGet(remote, '0xabcd');

    // Then
    expect(await block).toEqual(new Uint8Array([0xab, 0xcd]));
    expect(chains.remotes.map(remote => remote.genesisHash)).toEqual([bulletin.toLowerCase()]);
    expect(must(chains.remotes[0], 'remote').sent.filter(sent => sent.method === 'bitswap_v1_get')).toHaveLength(1);
  });
});
