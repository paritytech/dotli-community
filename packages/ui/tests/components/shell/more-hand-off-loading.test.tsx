// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { preloadDropdownMenuSurface } from '../../../src/components/floating/DropdownMenu.js';
import { preloadPopoverSurface } from '../../../src/components/floating/Popover.js';
import { PermissionsPopover } from '../../../src/components/shell/PermissionsPopover.js';
import { pointerPress, resetStores, settle } from '../../helpers/solid.js';
import { stubPhoneViewport } from '../../helpers/viewport.js';
import { byId } from '../../support.js';
import { moreRow, renderTopbar } from './topbar-harness.js';

const popoverChunk = vi.hoisted(() => ({ fetched: 0 }));
vi.mock('../../../src/components/floating/PopoverSurface.js', async importOriginal => {
  popoverChunk.fetched += 1;
  return importOriginal();
});

// As before the first idle preload: only More's chunk is in, no Popover's.
beforeAll(async () => {
  await preloadDropdownMenuSurface();
});

afterEach(() => {
  resetStores();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('The More sheet before any popover chunk is in', () => {
  it("As a phone user choosing Permissions in More right after load, the permissions sheet still takes More's place", async () => {
    // Given: Permissions collapsed into More, on a phone.
    stubPhoneViewport(true);
    await renderTopbar(() => <PermissionsPopover />, 1);
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
    pointerPress(moreRow('permissions'));
    await settle();

    // Then: Permissions took More's place, both marked as a hand-off.
    const more = byId('more-popover');
    expect(more.hasAttribute('data-open')).toBe(false);
    expect(more.hasAttribute('data-handoff')).toBe(true);
    const sheet = byId('permissions-popover');
    expect(sheet.hasAttribute('data-open')).toBe(true);
    expect(sheet.hasAttribute('data-handoff')).toBe(true);
  });
});
