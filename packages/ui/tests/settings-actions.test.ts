// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModeDraft } from '../src/settings-actions.js';

const mocks = vi.hoisted(() => ({
  clearInstalledExecutableCache: vi.fn(() => Promise.resolve()),
  clearBlockCache: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../storage/src/cid-cache.js', async importOriginal => ({
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- required for mock typing
  ...(await importOriginal<typeof import('../../storage/src/cid-cache.js')>()),
  clearInstalledExecutableCache: mocks.clearInstalledExecutableCache,
}));
vi.mock('../../storage/src/block-cache.js', () => ({
  clearBlockCache: mocks.clearBlockCache,
}));

const CACHE_ON = {
  skipCidCache: false,
  skipArchiveCache: false,
  skipWorkerCache: false,
};

const prior: ModeDraft = {
  chain: 'smoldot-direct',
  network: 'paseo-next-v2',
  cache: CACHE_ON,
  polkaVmAppsEnabled: true,
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
