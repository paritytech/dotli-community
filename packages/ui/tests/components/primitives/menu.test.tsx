// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Menu, MenuRow } from '../../../src/components/primitives/Menu.js';
import { drag } from '../../helpers/drag.js';
import { renderComponent, settle } from '../../helpers/solid.js';
import { byId, byTestId } from '../../support.js';

/** An open menu named Things, as a sheet or not. */
function renderMenu(sheet: boolean): { setOpen: (open: boolean) => void } {
  const setOpen = vi.fn<(open: boolean) => void>();
  const popover = { open: () => true, sheet: () => sheet, handedOff: () => false, setOpen };
  renderComponent(() => (
    <Menu ref={() => undefined} id="menu" popover={popover} label="Things">
      <MenuRow data-item="one">One</MenuRow>
    </Menu>
  ));
  return { setOpen };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Menu', () => {
  it('As a phone user, a menu sheet shows its title and a close button over a scrim, and a screen reader hears the menu by its own name', async () => {
    // When
    renderMenu(true);
    await settle();

    // Then: the head leads the sheet, outside the menu, which holds only its items.
    const sheet = byId('menu');
    expect(sheet.hasAttribute('data-sheet')).toBe(true);
    const head = byTestId('menu-sheet-head', sheet);
    expect(sheet.firstElementChild).toBe(head);
    expect(byTestId('menu-sheet-title', head).textContent).toBe('Things');
    expect(byTestId('menu-sheet-close', head).getAttribute('aria-label')).toBe('Close');
    const menu = byTestId('menu-sheet-body', sheet);
    expect(menu.getAttribute('role')).toBe('menu');
    expect(menu.getAttribute('aria-label')).toBe('Things');
    expect(menu.contains(head)).toBe(false);
    expect(byTestId('menu-scrim').hasAttribute('data-open')).toBe(true);
  });

  it('As a phone user, the close button in the menu sheet head asks to close it', async () => {
    // Given
    const { setOpen } = renderMenu(true);
    await settle();

    // When
    byTestId('menu-sheet-close').click();

    // Then
    expect(setOpen).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('As a desktop user, a menu that is no sheet has no head and no scrim', async () => {
    // When
    renderMenu(false);
    await settle();

    // Then
    expect(byId('menu').hasAttribute('data-sheet')).toBe(false);
    expect(byId('menu').getAttribute('role')).toBe('menu');
    expect(document.querySelector('[data-testid="menu-sheet-head"]')).toBeNull();
    expect(document.querySelector('[data-testid="menu-scrim"]')).toBeNull();
  });

  it('As a phone user, a swipe down on the sheet head asks to close it, and a jittery tap does not', async () => {
    // Given
    const { setOpen } = renderMenu(true);
    await settle();
    vi.spyOn(byId('menu'), 'offsetHeight', 'get').mockReturnValue(300);
    const head = byTestId('menu-sheet-head');

    // When
    drag(head, 4, 5);

    // Then
    expect(setOpen).not.toHaveBeenCalled();
    expect(byId('menu').style.transform).toBe('');
    expect(byId('menu').hasAttribute('data-dragging')).toBe(false);

    // When
    drag(head, 120, 1000);

    // Then
    expect(setOpen).toHaveBeenCalledExactlyOnceWith(false);
  });
});
