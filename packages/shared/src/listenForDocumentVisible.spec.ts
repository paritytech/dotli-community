// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { listenForDocumentVisible } from './listenForDocumentVisible.js';
import { createFakePage } from './testing/createFakePage.js';

describe('listenForDocumentVisible', () => {
  it('As a tab, I hear when I become visible and not when I am hidden', () => {
    // Given a hidden page with a visibility listener
    const page = createFakePage();
    page.setVisibility('hidden');
    const handler = vi.fn();
    const stop = listenForDocumentVisible(page.document, handler);

    // When the page shows, hides, stops listening and shows again
    page.setVisibility('visible');
    page.setVisibility('hidden');
    stop();
    page.setVisibility('visible');

    // Then only the first showing was heard
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
