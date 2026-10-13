// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { vi } from 'vitest';

/**
 * A browser that is idle at once, so an idle preload puts a Popover's surface in the page before any opening.
 * `requested` resolves once the page asks for its first idle callback.
 */
export function stubIdleBrowser(): { requested: Promise<void> } {
  let asked: () => void = () => undefined;
  const requested = new Promise<void>(resolve => {
    asked = resolve;
  });
  vi.stubGlobal('requestIdleCallback', (run: () => void) => {
    asked();
    return setTimeout(run, 0);
  });
  vi.stubGlobal('cancelIdleCallback', (handle: ReturnType<typeof setTimeout>) => {
    clearTimeout(handle);
  });
  return { requested };
}
