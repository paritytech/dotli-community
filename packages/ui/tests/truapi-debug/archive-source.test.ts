// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Config from '@dotli/config';

const mocks = vi.hoisted(() => ({
  backend: 'smoldot-direct',
  readArchiveFiles: vi.fn(),
}));

vi.mock('@dotli/config', async importOriginal => ({
  ...(await importOriginal<typeof Config>()),
  getBackend: () => mocks.backend,
}));
vi.mock('@dotli/content', () => ({
  loadFetch: () => Promise.resolve({ readArchiveFiles: mocks.readArchiveFiles }),
}));

const { productArchiveLoader } = await import('../../src/components/truapi-debug/archive-source.js');

describe('productArchiveLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readArchiveFiles.mockResolvedValue({ 'index.html': new Uint8Array([1]) });
  });

  it('As a dotli developer on rpc-gateway, the archive is read from the IPFS gateway, as the sandbox reads it', async () => {
    // Given
    mocks.backend = 'rpc-gateway';
    const blockSource = vi.fn<(cid: string) => Promise<Uint8Array>>();

    // When
    const files = await productArchiveLoader(blockSource)('bafyroot');

    // Then
    expect(mocks.readArchiveFiles).toHaveBeenCalledWith('bafyroot', { gateway: true });
    expect(blockSource).not.toHaveBeenCalled();
    expect(Object.keys(files)).toEqual(['index.html']);
  });

  it('As a dotli developer on the light client, blocks come from the block source the host hands in', async () => {
    // Given
    mocks.backend = 'smoldot-direct';
    const blockSource = vi.fn<(cid: string) => Promise<Uint8Array>>();

    // When
    await productArchiveLoader(blockSource)('bafyroot');

    // Then
    expect(mocks.readArchiveFiles).toHaveBeenCalledWith('bafyroot', { blockSource });
  });

  it('As a dotli developer on the light client with no block source, the archive is read from the gateway', async () => {
    // Given
    mocks.backend = 'smoldot-direct';

    // When
    await productArchiveLoader()('bafyroot');

    // Then
    expect(mocks.readArchiveFiles).toHaveBeenCalledWith('bafyroot', { gateway: true });
  });
});
