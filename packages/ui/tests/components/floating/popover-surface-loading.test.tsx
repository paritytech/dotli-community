// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { Popover } from '../../../src/components/floating/Popover.js';
import type * as SurfaceModule from '../../../src/components/floating/PopoverSurface.js';
import { mouseClick, renderComponent, settle } from '../../helpers/solid.js';
import { byId } from '../../support.js';

/** The surface's chunk, held back until `release()`. */
const chunk = vi.hoisted(() => {
  let release = (): void => undefined;
  const loaded = new Promise<void>(resolve => {
    release = resolve;
  });
  return {
    loaded,
    release: () => {
      release();
    },
  };
});

// The shell's import resolves at once (the setup's preload), to a surface
// that renders only once the chunk is released: a chunk still on its way.
vi.mock('../../../src/components/floating/PopoverSurface.js', async importOriginal => {
  const { lazy } = await import('solid-js');
  return {
    PopoverSurface: lazy(() => chunk.loaded.then(() => importOriginal<typeof SurfaceModule>()), {
      export: 'PopoverSurface',
    }),
  };
});

describe('A Popover whose surface has not loaded', () => {
  it('As a dotli user on a slow network, a click opens it at once, a second closes it, and the surface shows once loaded', async () => {
    // Given
    const onOpenChange = vi.fn<(open: boolean) => void>();
    renderComponent(() => {
      const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
      return (
        <>
          <button ref={setButton} id="trigger" type="button">
            Open
          </button>
          <Popover id="slow" title="Slow" trigger={button()} onOpenChange={onOpenChange}>
            <button type="button" id="inside">
              Inside
            </button>
          </Popover>
        </>
      );
    });
    await settle();
    const trigger = byId('trigger');

    // When
    mouseClick(trigger);
    await settle();

    // Then: open, with no surface yet.
    expect(onOpenChange.mock.calls).toEqual([[true]]);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById('slow')).toBeNull();

    // When: the button again, with no layer for its invoker to close.
    mouseClick(trigger);
    await settle();

    // Then
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    // When: opened again, and the chunk arrives.
    mouseClick(trigger);
    await settle();
    chunk.release();

    // Then: the surface shows, open, with focus inside.
    await vi.waitFor(() => {
      expect(byId('slow').hasAttribute('data-open')).toBe(true);
    });
    expect(onOpenChange.mock.calls).toEqual([[true], [false], [true]]);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(byId('inside'));
  });
});
