// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { vi } from 'vitest';

/** A browser that is idle at once, so an idle preload puts a Popover's surface in the page before any opening. */
export function stubIdleBrowser(): void {
  vi.stubGlobal('requestIdleCallback', (run: () => void) => setTimeout(run, 0));
  vi.stubGlobal('cancelIdleCallback', (handle: ReturnType<typeof setTimeout>) => {
    clearTimeout(handle);
  });
}
