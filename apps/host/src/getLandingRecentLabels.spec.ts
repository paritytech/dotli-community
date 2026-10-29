// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createMemoryStorage } from '@dotli/shared/testing';
import { createRecentLabels } from './createRecentLabels.js';
import { createStorageMirror } from './createStorageMirror.js';
import { getLandingRecentLabels } from './getLandingRecentLabels.js';
import { createMemorySharedChannel } from './runtime/sharedMode.fake.js';

describe('the landing recents', () => {
  it('As a visitor on a landing page another site frames, I open my recents and they ask the shared store nothing, as that page configures no protocol frame', () => {
    // Given
    const list = vi.fn(() =>
      createRecentLabels({
        channel: createMemorySharedChannel(),
        mirror: createStorageMirror({ storage: createMemoryStorage() }),
      }),
    );
    const framed = { self: {}, top: {} };

    // When
    const recents = getLandingRecentLabels(framed, { list });

    // Then
    expect(recents).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
  });

  it('As a visitor on a landing page of its own, I open my recents and they come from the page list', () => {
    // Given
    const own = createRecentLabels({
      channel: createMemorySharedChannel(),
      mirror: createStorageMirror({ storage: createMemoryStorage() }),
    });
    const view = {};

    // When
    const recents = getLandingRecentLabels({ self: view, top: view }, { list: () => own });

    // Then
    expect(recents).toBe(own);
  });
});
