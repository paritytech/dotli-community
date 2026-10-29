// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '@dotli/shared/testing';
import { createLazyRecentLabels } from './createLazyRecentLabels.js';
import { createStorageMirror } from './createStorageMirror.js';
import { createMemorySharedChannel } from './runtime/sharedMode.fake.js';

describe("the page's recent labels", () => {
  it('As a visitor, I resolve two names at once on one page and both are recorded', async () => {
    // Given the page's list, built once over its shared store
    const channel = createMemorySharedChannel();
    const pageRecents = createLazyRecentLabels({
      channel: () => channel,
      mirror: createStorageMirror({ storage: createMemoryStorage() }),
    });

    // When
    await Promise.all([pageRecents().record('explore'), pageRecents().record('staking')]);

    // Then
    expect(channel.store.get('dotli_recent')).toBe('["staking","explore"]');
  });
});
