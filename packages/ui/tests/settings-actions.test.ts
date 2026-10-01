// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveServicesConfig } from '@dotli/config';
import type { RemoteChainProvider } from '@dotli/protocol';
import type { ModeDraft } from '../src/settings-actions.js';

const mocks = vi.hoisted(() => ({
  clearCidCache: vi.fn(() => Promise.resolve()),
  clearBlockCache: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../storage/src/cid-cache.js', async importOriginal => ({
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- required for mock typing
  ...(await importOriginal<typeof import('../../storage/src/cid-cache.js')>()),
  clearCidCache: mocks.clearCidCache,
}));
vi.mock('../../storage/src/block-cache.js', () => ({
  clearBlockCache: mocks.clearBlockCache,
}));

const probe = vi.hoisted(() => ({
  hostChainProvider: vi.fn<(genesisHash: string) => RemoteChainProvider | null>(),
  createClient: vi.fn(),
}));
vi.mock('../src/lazy.js', () => ({
  loadBridge: () => Promise.resolve({ hostChainProvider: probe.hostChainProvider }),
}));
vi.mock('polkadot-api', () => ({ createClient: probe.createClient }));

const CACHE_ON = {
  skipCidCache: false,
  skipArchiveCache: false,
  skipWorkerCache: false,
};

const prior: ModeDraft = {
  chain: 'smoldot-direct',
  network: 'paseo-next-v2',
  cache: CACHE_ON,
};

describe('applyAndReset: archive cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    vi.spyOn(window.location, 'reload').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('As a user, turning the archive cache off clears the blocks the host kept', async () => {
    // Given
    const { applyAndReset } = await import('../src/settings-actions.js');
    const draft: ModeDraft = {
      ...prior,
      cache: { ...CACHE_ON, skipArchiveCache: true },
    };

    // When
    await applyAndReset(draft, prior);

    // Then the host cache is cleared, and the sandbox, which holds nothing
    // across reloads, is not asked to reset
    expect(mocks.clearBlockCache).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('dotli:pending-reset:sandbox')).toBeNull();
  });

  it('As a user, turning the archive cache back on keeps nothing I would lose', async () => {
    // Given
    const { applyAndReset } = await import('../src/settings-actions.js');
    const off: ModeDraft = {
      ...prior,
      cache: { ...CACHE_ON, skipArchiveCache: true },
    };

    // When
    await applyAndReset(prior, off);

    // Then
    expect(mocks.clearBlockCache).not.toHaveBeenCalled();
  });
});

describe('queryFinalizedBlock', () => {
  const people = getActiveServicesConfig().people.genesis;
  const provider: RemoteChainProvider = () => ({ send: vi.fn(), disconnect: vi.fn() });

  beforeEach(() => {
    probe.hostChainProvider.mockReset().mockReturnValue(provider);
    probe.createClient.mockReset();
  });

  it("As a dotli user, the diagnostics read a chain's finalized block over the host pool", async () => {
    // Given
    const destroy = vi.fn<() => void>();
    probe.createClient.mockReturnValue({ getFinalizedBlock: () => Promise.resolve({ number: 42 }), destroy });
    const { queryFinalizedBlock } = await import('../src/settings-actions.js');

    // When
    const block = await queryFinalizedBlock(people);

    // Then
    expect(block).toBe(42);
    expect(probe.hostChainProvider).toHaveBeenCalledWith(people);
    expect(probe.createClient).toHaveBeenCalledWith(provider);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('As a dotli user, the diagnostics read no block for a chain the host pool cannot serve', async () => {
    // Given
    probe.hostChainProvider.mockReturnValue(null);
    const { queryFinalizedBlock } = await import('../src/settings-actions.js');

    // When
    const block = await queryFinalizedBlock(people);

    // Then
    expect(block).toBeNull();
    expect(probe.createClient).not.toHaveBeenCalled();
  });
});
