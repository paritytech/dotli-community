// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { createFallbackScreen, type FallbackPage } from './createFallbackScreen.js';

type FakeElement = {
  hidden: boolean;
  className: string;
  textContent: string;
  onclick: (() => void) | null;
};

/** The page's static markup of the screen, hidden until something shows it. */
function createFakePage() {
  const section = createFakeElement();
  const message = createFakeElement();
  const button = createFakeElement();
  const byId: Record<string, FakeElement> = {
    'sandbox-fallback': section,
    'sandbox-fallback-text': message,
    'sandbox-fallback-reload': button,
  };
  const page: FallbackPage = { getElementById: id => byId[id] ?? null };
  return { page, section, message, button };
}

function createFakeElement(): FakeElement {
  return { hidden: true, className: '', textContent: '', onclick: null };
}

describe('fallback screen', () => {
  it('As a visitor, I see the failure text and press a Reload that reloads the page', () => {
    // Given
    const { page, section, message, button } = createFakePage();
    const reload = vi.fn();
    const screen = createFallbackScreen({ page, reload });

    // When
    screen.show('Failed to load content.');
    screen.show('Second failure');
    button.onclick?.();

    // Then
    expect(section.hidden).toBe(false);
    expect(message.textContent).toBe('Second failure');
    expect(reload).toHaveBeenCalledOnce();
  });

  it('As a visitor whose page UI loaded after all, I see the fallback screen and it goes away', () => {
    // Given
    const { page, section } = createFakePage();
    const screen = createFallbackScreen({ page, reload: vi.fn() });
    screen.show('Failed to load content.');

    // When
    screen.hide();

    // Then
    expect(section.hidden).toBe(true);
  });

  it('As an operator, I serve a page without the fallback markup and its miss is reported instead of thrown', () => {
    // Given
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const screen = createFallbackScreen({ page: { getElementById: () => null }, reload: vi.fn() });

    // When
    screen.show('Failed to load content.');

    // Then
    expect(captures.exception).toHaveBeenCalledOnce();
    expect(captures.exception).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ flow: 'content', step: 'fallback_show' }),
    );
  });
});
