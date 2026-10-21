// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { hideFallbackScreen, showFallbackScreen, type FallbackPage } from './fallback-screen.js';

function fakePage() {
  const section = { hidden: true } as HTMLElement;
  const message = { textContent: '' } as HTMLElement;
  const button = { onclick: null } as unknown as HTMLButtonElement;
  const byId: Record<string, HTMLElement> = {
    'sandbox-fallback': section,
    'sandbox-fallback-text': message,
    'sandbox-fallback-reload': button,
  };
  const page: FallbackPage = { getElementById: id => byId[id] ?? null };
  return { page, section, message, button };
}

describe('fallback screen', () => {
  it('As a visitor, I see the failure text and a Reload that reloads the page', () => {
    // Given
    const { page, section, message, button } = fakePage();
    const reload = vi.fn();

    // When
    showFallbackScreen(page, 'Failed to load content.', reload);
    showFallbackScreen(page, 'Second failure', reload);
    (button as unknown as { onclick: () => void }).onclick();

    // Then
    expect(section.hidden).toBe(false);
    expect(message.textContent).toBe('Second failure');
    expect(reload).toHaveBeenCalledOnce();
  });

  it('As a visitor whose page UI loaded after all, the fallback screen goes away', () => {
    // Given
    const { page, section } = fakePage();
    showFallbackScreen(page, 'Failed to load content.', vi.fn());

    // When
    hideFallbackScreen(page);

    // Then
    expect(section.hidden).toBe(true);
  });

  it('As a visitor on a page without the fallback markup, the miss is reported instead of thrown', () => {
    // Given
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const page: FallbackPage = { getElementById: () => null };

    // When
    showFallbackScreen(page, 'Failed to load content.', vi.fn());

    // Then
    expect(captures.exception).toHaveBeenCalledOnce();
    expect(captures.exception).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ flow: 'content', step: 'fallback_show' }),
    );
  });
});
