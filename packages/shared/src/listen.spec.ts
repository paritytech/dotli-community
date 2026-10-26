// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { listen, onDocumentVisible, onPageReturn } from './listen.js';
import { FakePage } from './testing/fake-page.js';

describe('listen', () => {
  it('As a developer, I listen and hear each event until I stop with the stop it gave me', () => {
    // Given a listener on a target
    const target = new EventTarget();
    const handler = vi.fn();
    const stop = listen(target, 'ping', handler);

    // When an event fires, the listener stops and another fires
    target.dispatchEvent(new Event('ping'));
    stop();
    target.dispatchEvent(new Event('ping'));

    // Then only the first was heard
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('onDocumentVisible', () => {
  it('As a tab, I hear when I become visible and not when I am hidden', () => {
    // Given a hidden page with a visibility listener
    const page = new FakePage();
    page.setVisibility('hidden');
    const handler = vi.fn();
    const stop = onDocumentVisible(page.document, handler);

    // When the page shows, hides, stops listening and shows again
    page.setVisibility('visible');
    page.setVisibility('hidden');
    stop();
    page.setVisibility('visible');

    // Then only the first showing was heard
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('onPageReturn', () => {
  it('As a page in a window beside another, I hear the user come back by my focus, not only by my turning visible', () => {
    // Given a hidden page listening for the user's return
    const page = new FakePage();
    page.setVisibility('hidden');
    const handler = vi.fn();
    const stop = onPageReturn(page.document, page.window, handler);

    // When the window gains focus, the page shows, it stops and focus comes again
    page.window.dispatchEvent(new Event('focus'));
    page.setVisibility('visible');
    stop();
    page.window.dispatchEvent(new Event('focus'));

    // Then the focus and the showing before the stop were heard
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
