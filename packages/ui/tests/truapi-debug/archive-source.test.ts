// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  backend: 'smoldot-direct',
  readArchiveFiles: vi.fn(),
  bitswapGet: vi.fn(),
  getCachedBlock: vi.fn(),
}));

vi.mock('@dotli/config', () => ({ getBackend: () => mocks.backend }));
vi.mock('@dotli/content', () => ({
  bitswapGet: mocks.bitswapGet,
  loadFetch: () => Promise.resolve({ readArchiveFiles: mocks.readArchiveFiles }),
}));
vi.mock('@dotli/storage', () => ({ getCachedBlock: mocks.getCachedBlock }));

const { loadProductArchive } = await import('../../src/components/truapi-debug/archive-source.js');

type Transport = { gateway: true } | { blockSource: (cid: string) => Promise<Uint8Array> };

/** The transport `loadProductArchive` handed to `readArchiveFiles`. */
function transport(): Transport {
  const call = mocks.readArchiveFiles.mock.calls[0] as [string, Transport] | undefined;
  if (call === undefined) {
    throw new Error('readArchiveFiles was not called');
  }
  return call[1];
}

describe('loadProductArchive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readArchiveFiles.mockResolvedValue({ 'index.html': new Uint8Array([1]) });
  });

  it('As a dotli developer on rpc-gateway, the archive is read from the IPFS gateway, as the sandbox reads it', async () => {
    // Given
    mocks.backend = 'rpc-gateway';

    // When
    const files = await loadProductArchive('bafyroot');

    // Then
    expect(mocks.readArchiveFiles).toHaveBeenCalledWith('bafyroot', { gateway: true });
    expect(Object.keys(files)).toEqual(['index.html']);
  });

  it('As a dotli developer on the light client, blocks come from the block cache before bitswap', async () => {
    // Given
    mocks.backend = 'smoldot-direct';
    const cached = new Uint8Array([7]);
    const fetched = new Uint8Array([9]);
    mocks.getCachedBlock.mockImplementation((cid: string) => Promise.resolve(cid === 'bafyhit' ? cached : null));
    mocks.bitswapGet.mockResolvedValue(fetched);
    await loadProductArchive('bafyroot');
    const source = transport();
    if (!('blockSource' in source)) {
      throw new Error('expected a block source');
    }

    // When
    const hit = await source.blockSource('bafyhit');
    const miss = await source.blockSource('bafymiss');

    // Then
    expect(hit).toBe(cached);
    expect(miss).toBe(fetched);
    expect(mocks.bitswapGet).toHaveBeenCalledTimes(1);
    expect(mocks.bitswapGet).toHaveBeenCalledWith('bafymiss');
  });
});
