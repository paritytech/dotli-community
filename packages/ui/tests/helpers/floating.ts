// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll } from 'vitest';

/**
 * Load Popover's and DropdownMenu's surface chunks, from the current module
 * graph (a file that resets its modules calls it again after the reset).
 */
export async function preloadFloatingSurfaces(): Promise<void> {
  const [popover, menu] = await Promise.all([
    import('../../src/components/floating/Popover.js'),
    import('../../src/components/floating/DropdownMenu.js'),
  ]);
  await Promise.all([popover.preloadPopoverSurface(), menu.preloadDropdownMenuSurface()]);
}

/**
 * For a file whose tests open a Popover or DropdownMenu and read its surface
 * in the same tick, as they could while it was eager: the chunks load once,
 * ahead of the file's tests. Imported in the hook, so the file's `vi.mock`s
 * apply to the shells' graph.
 */
export function useFloatingSurfaces(): void {
  beforeAll(preloadFloatingSurfaces);
}
