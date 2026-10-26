// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { listenForPageReturn } from './listenForPageReturn.js';
import { createFakePage } from './testing/createFakePage.js';

describe('listenForPageReturn', () => {
  it('As a page in a window beside another, I listen for the user and hear them come back by my focus as well as by my turning visible', () => {
    // Given a hidden page listening for the user's return
    const page = createFakePage();
    page.setVisibility('hidden');
    const handler = vi.fn();
    const stop = listenForPageReturn({ visibility: page.document, target: page.window, handler });

    // When the window gains focus, the page shows, it stops and focus comes again
    page.window.dispatchEvent(new Event('focus'));
    page.setVisibility('visible');
    stop();
    page.window.dispatchEvent(new Event('focus'));

    // Then the focus and the showing before the stop were heard
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
