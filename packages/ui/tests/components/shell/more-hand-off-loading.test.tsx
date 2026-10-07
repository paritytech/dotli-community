// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { preloadDropdownMenuSurface } from '../../../src/components/floating/DropdownMenu.js';
import { preloadPopoverSurface } from '../../../src/components/floating/Popover.js';
import { ThemeToggle } from '../../../src/components/shell/ThemeToggle.js';
import { pointerPress, resetStores, settle } from '../../helpers/solid.js';
import { stubPhoneViewport } from '../../helpers/viewport.js';
import { byId } from '../../support.js';
import { moreRow, renderTopbar } from './topbar-harness.js';

/** Popover's surface chunk, counted as it is fetched. */
const popoverChunk = vi.hoisted(() => ({ fetched: 0 }));
vi.mock('../../../src/components/floating/PopoverSurface.js', async importOriginal => {
  popoverChunk.fetched += 1;
  return importOriginal();
});

// Only More's chunk is in, as before the first idle preload: no Popover has
// loaded its own.
beforeAll(async () => {
  await preloadDropdownMenuSurface();
});

afterEach(() => {
  resetStores();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('The More sheet before any popover chunk is in', () => {
  it("As a phone user choosing Appearance in More right after load, the Appearance sheet still takes More's place", async () => {
    // Given: Appearance collapsed into More, on a phone.
    stubPhoneViewport(true);
    await renderTopbar(() => <ThemeToggle />, 1);
    expect(popoverChunk.fetched).toBe(0);

    // When: More opens.
    pointerPress(byId('more-button'));
    await settle();

    // Then: its surface fetches Popover's chunk.
    await vi.waitFor(() => {
      expect(popoverChunk.fetched).toBe(1);
    });
    await preloadPopoverSurface();

    // When
    pointerPress(moreRow('theme'));
    await settle();

    // Then: Appearance took More's place, both marked as a hand-off.
    const more = byId('more-popover');
    expect(more.hasAttribute('data-open')).toBe(false);
    expect(more.hasAttribute('data-handoff')).toBe(true);
    const sheet = byId('theme-popover');
    expect(sheet.hasAttribute('data-open')).toBe(true);
    expect(sheet.hasAttribute('data-handoff')).toBe(true);
  });
});
