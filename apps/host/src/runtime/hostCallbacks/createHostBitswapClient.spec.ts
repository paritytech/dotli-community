// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { JsonRpcId } from '@polkadot-api/json-rpc-provider';
import { getActiveServicesConfig, getSettings, setSettings } from '@dotli/config';
import type { ChainActivity } from '@dotli/chains';
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

  it('As a host page, my fetch ends and my lease on Bulletin is released', async () => {
    // Given
    const pool = createHostChainPool({ createRemoteChain: chains.createRemoteChain, destroyDelay: 0 });
    const reported: ChainActivity[] = [];
    onTestFinished(pool.watch({ onActivity: activity => reported.push(activity), onBestBlock: () => undefined }));
    const client = createHostBitswapClient({ pool });

    // When
    const block = client.get('bafyTest');
    const remote = await vi.waitFor(() => must(chains.remotes[0], 'remote'));
    await answerGet(remote, '0xabcd');
    await block;

    // Then
    expect(reported.findLast(activity => activity.genesisHash === bulletin.toLowerCase())?.consumers).toBe(0);
  });

  it('As a host page whose protocol frame cannot serve Bulletin, I see the fetch fail as unavailable', async () => {
    // Given
    chains.createRemoteChain.mockReturnValue(null);
    const pool = createHostChainPool({ createRemoteChain: chains.createRemoteChain, destroyDelay: 0 });
    const client = createHostBitswapClient({ pool });

    // When
    const block = client.get('bafyTest');

    // Then
    // The value of BITSWAP_ERRORS.UNAVAILABLE, which the package does not export.
    await expect(block).rejects.toMatchObject({ name: 'BitswapUnavailableError' });
  });
});
