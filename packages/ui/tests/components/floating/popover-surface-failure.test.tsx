// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { Popover } from '../../../src/components/floating/Popover.js';
import type * as SurfaceModule from '../../../src/components/floating/PopoverSurface.js';
import { mouseClick, renderComponent, settle } from '../../helpers/solid.js';
import { byId } from '../../support.js';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../../../metrics/src/sentry.js', () => sentry);

/** How many times the surface was fetched; the first fails, as a chunk gone after a deploy. */
const fetches = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../../src/components/floating/PopoverSurface.js', async importOriginal => {
  const { lazy } = await import('solid-js');
  return {
    PopoverSurface: lazy(
      () => {
        fetches.count += 1;
        return fetches.count === 1 ? Promise.reject(new Error('chunk')) : importOriginal<typeof SurfaceModule>();
      },
      { export: 'PopoverSurface' },
    ),
  };
});

describe('A popover whose surface chunk fails', () => {
  it('As a dotli user, a surface that cannot load is reported once and closes, and the next opening loads it and shows', async () => {
    // Given
    const onOpenChange = vi.fn<(open: boolean) => void>();
    renderComponent(() => {
      const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
      return (
        <>
          <button ref={setButton} id="trigger" type="button">
            Open
          </button>
          <Popover id="broken" title="Broken" trigger={button()} onOpenChange={onOpenChange}>
            <button type="button" id="inside">
              Inside
            </button>
          </Popover>
        </>
      );
    });
    await settle();

    // When
    mouseClick(byId('trigger'));
    await vi.waitFor(() => {
      expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
    });
    await settle();

    // Then: reported once, closed, and out of the page.
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      flow: 'ui',
      step: 'root_render',
      tags: { root: 'popover:broken' },
    });
    expect(byId('trigger').getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById('broken')).toBeNull();

    // When: opened again.
    mouseClick(byId('trigger'));

    // Then: the surface is fetched again and shows, open.
    await vi.waitFor(() => {
      expect(document.getElementById('broken')?.hasAttribute('data-open')).toBe(true);
    });
    expect(fetches.count).toBe(2);
    expect(onOpenChange.mock.calls).toEqual([[true], [false], [true]]);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
