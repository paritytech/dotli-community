// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What story plays share beyond `storybook/test`.

import type { userEvent } from 'vitest/browser';

/**
 * Trusted input, which the browser's invokers and a real `:hover` require. Loaded on demand, so Storybook still opens
 * the stories outside Vitest.
 */
export async function trustedInput(): Promise<typeof userEvent> {
  const browser = await import('vitest/browser');
  return browser.userEvent;
}
