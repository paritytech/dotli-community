// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What story plays share beyond `storybook/test`. Plays run under the Playwright provider, whose types give a
// `cdp()` session its `send`.

/// <reference types="@vitest/browser-playwright" />

import { expect } from 'storybook/test';
import type { userEvent } from 'vitest/browser';

/**
 * Trusted input, which the browser's invokers and a real `:hover` require. Loaded on demand, so Storybook still opens
 * the stories outside Vitest.
 */
export async function trustedInput(): Promise<typeof userEvent> {
  const browser = await import('vitest/browser');
  return browser.userEvent;
}

/** Asserts `first` comes before `second` in reading and focus order. */
export async function expectBefore(first: Element, second: Element): Promise<void> {
  await expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
}
