// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { Popover } from '../../../src/components/floating/Popover.js';
import { mouseClick, renderComponent, settle } from '../../helpers/solid.js';
import { byId } from '../../support.js';

/** The surface's chunk, on its way until `release()`. */
const chunk = vi.hoisted(() => {
  let release = (): void => undefined;
  const arrived = new Promise<void>(resolve => {
    release = resolve;
  });
  return {
    arrived,
    release: () => {
      release();
    },
  };
});

vi.mock('../../../src/components/floating/PopoverSurface.js', async importOriginal => {
  await chunk.arrived;
  return importOriginal();
});

describe('A popover opened while its surface is on its way, then a modal', () => {
  it('As a dotli user on a slow network, opening Settings and then signing in leaves the sign-in on top and focused', async () => {
    // Given
    const onOpenChange = vi.fn<(open: boolean) => void>();
    renderComponent(() => {
      const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
      return (
        <>
          <button ref={setButton} id="settings-trigger" type="button">
            Settings
          </button>
          <Popover id="settings" title="Settings" trigger={button()} onOpenChange={onOpenChange}>
            <button type="button" id="settings-inside">
              Inside
            </button>
          </Popover>
          <dialog id="sign-in">
            <button type="button" id="sign-in-inside">
              Sign in
            </button>
          </dialog>
        </>
      );
    });
    await settle();

    // When: Settings opens, and before its surface is in, the sign-in modal opens and takes focus.
    byId('settings-trigger').focus();
    mouseClick(byId('settings-trigger'));
    await settle();
    byId('sign-in', HTMLDialogElement).showModal();
    byId('sign-in-inside').focus();
    chunk.release();
    await vi.waitFor(() => {
      expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
    });
    await settle();

    // Then: Settings closed without showing over the modal, and focus stayed in it.
    expect(document.getElementById('settings')?.hasAttribute('data-open') ?? false).toBe(false);
    expect(byId('settings-trigger').getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(byId('sign-in-inside'));
  });
});
