// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The topbar's collapsible action group (components/shell/topbar/
// ActionGroup.tsx), with stand-in items. The real items reaching their
// surfaces from the More menu are covered in their own tests and in
// topbar-actions.test.tsx (the action group island).

import { createSignal } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TopbarContext, type TopbarBar } from '../../../src/components/shell/topbar/context.js';
import { PINNED } from '../../../src/components/shell/topbar/fit.js';
import { OverflowMenu } from '../../../src/components/shell/topbar/OverflowMenu.js';
import { TopbarItem } from '../../../src/components/shell/topbar/TopbarItem.js';
import { setBlockingModalActive } from '../../../src/state/topbar.js';
import { mouseClick, pointerPress, renderComponent, resetStores, settle } from '../../helpers/solid.js';
import { byId, byTestId } from '../../support.js';
import { ITEM_WIDTH, moreRow, renderTopbar } from './topbar-harness.js';

interface Activation {
  name: string;
  detail: number;
}

let activations: Activation[] = [];

function Item(props: { name: string; priority: number; visible?: boolean }): JSX.Element {
  return (
    <TopbarItem
      name={props.name}
      label={props.name.toUpperCase()}
      icon={() => <svg data-testid={`icon-${props.name}`} />}
      priority={props.priority}
      visible={props.visible ?? true}
      activate={ev => {
        activations.push({ name: props.name, detail: ev.detail });
      }}
    >
      <button id={`${props.name}-button`} type="button">
        {props.name}
      </button>
    </TopbarItem>
  );
}

/** Auth (pinned), network 5, chat 4, permissions 3, theme 2, settings 1. */
function Items(props: { chat?: boolean }): JSX.Element {
  return (
    <>
      <Item name="auth" priority={PINNED} />
      <Item name="network" priority={5} />
      <Item name="chat" priority={4} visible={props.chat ?? true} />
      <Item name="permissions" priority={3} />
      <Item name="theme" priority={2} />
      <Item name="settings" priority={1} />
    </>
  );
}

/** Room for `n` items side by side (no gap in the stand-in layout). */
const room = (n: number): number => n * ITEM_WIDTH;

function inline(name: string): boolean {
  const el = document.querySelector<HTMLElement>(`[data-testid="topbar-item"][data-item="${name}"]`);
  return el !== null && el.hidden === false && !el.hasAttribute('data-collapsed');
}

function rowNames(): string[] {
  return [...document.querySelectorAll<HTMLElement>('#more-popover [role="menuitem"]')].map(
    el => el.dataset['item'] ?? '',
  );
}

function moreShows(): boolean {
  return !byId('more-button').hasAttribute('data-idle');
}

function isOpen(): boolean {
  return byId('more-popover').hasAttribute('data-open');
}

async function pressKey(key: string): Promise<void> {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
  await settle();
}

afterEach(() => {
  activations = [];
  resetStores();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ActionGroup', () => {
  it('As a desktop user, every item sits in the bar when there is room, and the More button stays out of the way', async () => {
    // When
    await renderTopbar(() => <Items />, room(6));

    // Then
    for (const name of ['auth', 'network', 'chat', 'permissions', 'theme', 'settings']) {
      expect(inline(name)).toBe(true);
    }
    expect(moreShows()).toBe(false);
    expect(rowNames()).toEqual([]);
  });

  it('As a user narrowing the window, items move into More lowest priority first, and the rows keep the bar order', async () => {
    // Given
    const layout = await renderTopbar(() => <Items />, room(6));

    // When: room for five, one of them the More button.
    layout.setRoom(room(5));
    await settle();

    // Then
    expect(inline('settings')).toBe(false);
    expect(inline('theme')).toBe(false);
    expect(inline('permissions')).toBe(true);
    expect(moreShows()).toBe(true);
    expect(rowNames()).toEqual(['theme', 'settings']);

    // When: room for two.
    layout.setRoom(room(2));
    await settle();

    // Then: only the pinned account button and More are left.
    expect(inline('auth')).toBe(true);
    expect(rowNames()).toEqual(['network', 'chat', 'permissions', 'theme', 'settings']);
  });

  it('As a phone user, the account button stays in the bar even when nothing fits', async () => {
    // When
    await renderTopbar(() => <Items />, 0.5 * ITEM_WIDTH);

    // Then
    expect(inline('auth')).toBe(true);
    expect(rowNames()).not.toContain('auth');
  });

  it('As a user widening the window, collapsed items come back and an open More menu closes with its last row', async () => {
    // Given
    const layout = await renderTopbar(() => <Items />, room(5));
    mouseClick(byId('more-button'));
    await settle();
    expect(isOpen()).toBe(true);
    expect(byTestId('more-hamburger').hasAttribute('data-open')).toBe(true);

    // When
    layout.setRoom(room(6));
    await settle();

    // Then
    expect(inline('settings')).toBe(true);
    expect(inline('theme')).toBe(true);
    expect(rowNames()).toEqual([]);
    expect(moreShows()).toBe(false);
    expect(isOpen()).toBe(false);
    expect(byTestId('more-hamburger').hasAttribute('data-open')).toBe(false);
  });

  it('As a user widening the window, items that collapsed into More come back once the pill has room', async () => {
    // Given: the pill gives the group room for two items
    let available = room(2);
    await renderTopbar(() => <Items />, room(2), { room: () => available });
    expect(inline('settings')).toBe(false);

    // When: the window widens, so the pill has room for all six
    available = room(6);
    window.dispatchEvent(new Event('resize'));
    await settle();

    // Then
    for (const name of ['auth', 'network', 'chat', 'permissions', 'theme', 'settings']) {
      expect(inline(name)).toBe(true);
    }
  });

  it('As a user, a hidden item shows neither in the bar nor in More, and takes its share of the room once it shows', async () => {
    // Given: room for all but chat.
    const [chat, setChat] = createSignal(false);
    await renderTopbar(() => <Items chat={chat()} />, room(5));
    expect(inline('chat')).toBe(false);
    expect(rowNames()).toEqual([]);

    // When
    setChat(true);
    await settle();

    // Then
    expect(inline('chat')).toBe(true);
    expect(rowNames()).toEqual(['theme', 'settings']);
  });

  it('As a user, an item growing (a longer account badge) pushes others into More', async () => {
    // Given
    const layout = await renderTopbar(() => <Items />, room(6));

    // When
    layout.setWidth('auth', 2 * ITEM_WIDTH);
    await settle();

    // Then
    expect(rowNames()).toEqual(['theme', 'settings']);
  });

  it('As a mobile user, choosing a row closes the menu, hands focus to More and activates the item with my tap', async () => {
    // Given
    await renderTopbar(() => <Items />, room(5));
    mouseClick(byId('more-button'));
    await settle();
    const outsideClicks = vi.fn();
    document.addEventListener('click', outsideClicks);

    // When
    mouseClick(moreRow('theme'));
    await settle();
    document.removeEventListener('click', outsideClicks);

    // Then
    expect(activations).toEqual([{ name: 'theme', detail: 1 }]);
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(byId('more-button'));
    // The row's own click stops at the menu: a surface it opened would see
    // it as outside.
    expect(outsideClicks).not.toHaveBeenCalled();
  });

  it('As a keyboard user, Enter on More opens the menu on its first row, the arrows move, and Enter activates with detail 0', async () => {
    // Given
    await renderTopbar(() => <Items />, room(4));
    byId('more-button').focus();

    // When
    await pressKey('Enter');

    // Then
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(moreRow('permissions'));

    // When / Then
    await pressKey('ArrowDown');
    expect(document.activeElement).toBe(moreRow('theme'));
    await pressKey('End');
    expect(document.activeElement).toBe(moreRow('settings'));

    // When: a focused button turns Enter into a click with detail 0.
    moreRow('settings').click();
    await settle();

    // Then
    expect(activations).toEqual([{ name: 'settings', detail: 0 }]);
    expect(isOpen()).toBe(false);
  });

  it('As a keyboard user, ArrowRight and ArrowLeft leave the focus on its row in the More menu, a column', async () => {
    // Given
    await renderTopbar(() => <Items />, room(4));
    byId('more-button').focus();
    await pressKey('Enter');
    expect(document.activeElement).toBe(moreRow('permissions'));

    // When
    await pressKey('ArrowRight');
    await pressKey('ArrowLeft');

    // Then
    expect(document.activeElement).toBe(moreRow('permissions'));
    expect(byId('more-popover').hasAttribute('aria-orientation')).toBe(false);
  });

  it('As a screen-reader user, the More button announces its menu, and each row is a menu item with the item label and icon', async () => {
    // When
    await renderTopbar(() => <Items />, room(5));

    // Then
    const button = byId('more-button');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-controls')).toBe('more-popover');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const popover = byId('more-popover');
    expect(popover.getAttribute('role')).toBe('menu');
    expect(popover.getAttribute('aria-labelledby')).toBe('more-button');
    const row = moreRow('theme');
    expect(row.getAttribute('role')).toBe('menuitem');
    expect(row.getAttribute('tabindex')).toBe('-1');
    expect(row.textContent).toBe('THEME');
    expect(row.querySelector('svg[data-testid="icon-theme"]')).not.toBeNull();
  });

  it('As a mobile user, a tap outside the menu or a blocking modal closes it', async () => {
    // Given
    await renderTopbar(() => <Items />, room(5));
    const outside = document.createElement('button');
    document.body.append(outside);
    mouseClick(byId('more-button'));
    await settle();

    // When
    pointerPress(outside);
    await settle();

    // Then
    expect(isOpen()).toBe(false);

    // When
    mouseClick(byId('more-button'));
    await settle();
    setBlockingModalActive(true);
    await settle();

    // Then
    expect(isOpen()).toBe(false);
  });

  it('As the build-time render, the items that may collapse are marked, and the More button is idle', async () => {
    // Given: a bar that has not measured yet, as in the host page's build-time render.
    const bar: TopbarBar = {
      register: () => () => false,
      observe: () => undefined,
      moreButton: () => undefined,
    };

    // When
    renderComponent(() => (
      <TopbarContext value={bar}>
        <Items />
        <OverflowMenu rows={[]} buttonRef={() => undefined} />
      </TopbarContext>
    ));
    await settle();

    // Then: until the bar measures, a narrow viewport keeps these out and shows the More button.
    const mayCollapse = [...document.querySelectorAll<HTMLElement>('[data-testid="topbar-item"]')]
      .filter(item => item.hasAttribute('data-may-collapse'))
      .map(item => item.dataset['item']);
    expect(mayCollapse).toEqual(['network', 'chat', 'permissions', 'theme', 'settings']);
    expect(byId('more-button').hasAttribute('data-idle')).toBe(true);
  });

  it('As a user, a collapsed item stays in place, out of the tab order, so its surface keeps its anchor', async () => {
    // When
    await renderTopbar(() => <Items />, room(5));

    // Then
    const wrapper = byId('settings-button').parentElement;
    expect(wrapper?.hasAttribute('data-collapsed')).toBe(true);
    expect(byId('settings-button').isConnected).toBe(true);
  });
});
