// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll } from 'vitest';

/** Loads the surface chunks from the current module graph, so a file that resets its modules calls it again. */
export async function preloadFloatingSurfaces(): Promise<void> {
  const [popover, menu] = await Promise.all([
    import('../../src/components/floating/Popover.js'),
    import('../../src/components/floating/DropdownMenu.js'),
  ]);
  await Promise.all([popover.preloadPopoverSurface(), menu.preloadDropdownMenuSurface()]);
}

/**
 * Loads the surface chunks before the file's tests, for tests that read a surface in the tick it opens. Imported in
 * the hook, so the file's `vi.mock`s apply to the surfaces' graph.
 */
export function useFloatingSurfaces(): void {
  beforeAll(preloadFloatingSurfaces);
}
