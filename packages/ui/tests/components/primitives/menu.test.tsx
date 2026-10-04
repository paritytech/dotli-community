// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Menu, MenuRow } from '../../../src/components/primitives/Menu.js';
import { drag } from '../../helpers/drag.js';
import { renderComponent, settle } from '../../helpers/solid.js';
import { byId, byTestId } from '../../support.js';

/** An open menu named Things, as a sheet or not. */
function renderMenu(sheet: boolean): { onDismiss: () => void } {
  const onDismiss = vi.fn<() => void>();
  renderComponent(() => (
    <Menu ref={() => undefined} id="menu" open label="Things" sheet={sheet} sheetTitle="Things" onDismiss={onDismiss}>
      <MenuRow data-item="one">One</MenuRow>
    </Menu>
  ));
  return { onDismiss };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Menu', () => {
  it('As a phone user, a menu sheet shows its title over a scrim, and a screen reader hears the menu by its own name', async () => {
    // When
    renderMenu(true);
    await settle();

    // Then
    const menu = byId('menu');
    expect(menu.hasAttribute('data-sheet')).toBe(true);
    expect(menu.getAttribute('role')).toBe('menu');
    expect(menu.getAttribute('aria-label')).toBe('Things');
    const head = byTestId('menu-sheet-head', menu);
    expect(menu.firstElementChild).toBe(head);
    expect(head.getAttribute('aria-hidden')).toBe('true');
    expect(byTestId('menu-sheet-title', head).textContent).toBe('Things');
    expect(byTestId('menu-scrim').hasAttribute('data-open')).toBe(true);
  });

  it('As a desktop user, a menu that is no sheet has no head and no scrim', async () => {
    // When
    renderMenu(false);
    await settle();

    // Then
    expect(byId('menu').hasAttribute('data-sheet')).toBe(false);
    expect(document.querySelector('[data-testid="menu-sheet-head"]')).toBeNull();
    expect(document.querySelector('[data-testid="menu-scrim"]')).toBeNull();
  });

  it('As a phone user, a swipe down on the sheet head asks to close it, and a jittery tap does not', async () => {
    // Given
    const { onDismiss } = renderMenu(true);
    await settle();
    vi.spyOn(byId('menu'), 'offsetHeight', 'get').mockReturnValue(300);
    const head = byTestId('menu-sheet-head');

    // When
    drag(head, 4, 5);

    // Then
    expect(onDismiss).not.toHaveBeenCalled();
    expect(byId('menu').style.transform).toBe('');
    expect(byId('menu').hasAttribute('data-dragging')).toBe(false);

    // When
    drag(head, 120, 1000);

    // Then
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
