// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The topbar's collapsible action group (components/shell/topbar/
// ActionGroup.tsx), with stand-in items. The real items reaching their
// surfaces from the More menu are covered in their own tests and in
// topbar-actions.test.tsx (the action group island).

import { createSignal } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { cleanup } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TopbarContext, type TopbarAlert, type TopbarBar } from '../../../src/components/shell/topbar/context.js';
import { PINNED } from '../../../src/components/shell/topbar/fit.js';
import { OverflowMenu } from '../../../src/components/shell/topbar/OverflowMenu.js';
import { TopbarItem } from '../../../src/components/shell/topbar/TopbarItem.js';
import { mouseClick, renderComponent, resetStores, settle } from '../../helpers/solid.js';
import { byId, byTestId } from '../../support.js';
import { ITEM_WIDTH, moreRow, moreRowNames as rowNames, openMore, renderTopbar } from './topbar-harness.js';
import { stubPhoneViewport } from '../../helpers/viewport.js';

interface Activation {
  name: string;
  detail: number;
}

let activations: Activation[] = [];

function Item(props: {
  name: string;
  priority: number;
  visible?: boolean;
  alert?: TopbarAlert | undefined;
  aside?: string | undefined;
}): JSX.Element {
  return (
    <TopbarItem
      name={props.name}
      label={props.name.toUpperCase()}
      icon={() => <svg data-testid={`icon-${props.name}`} />}
      priority={props.priority}
      visible={props.visible ?? true}
      alert={props.alert}
      aside={props.aside === undefined ? undefined : () => props.aside}
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
  return el !== null && el.hidden === false && !el.hasAttribute('data-parked');
}

function moreShows(): boolean {
  return !byTestId('more-item').hasAttribute('data-parked');
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
  // Dispose first: the menu's portal removes its own node from the body.
  cleanup();
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
    expect(await rowNames()).toEqual(['theme', 'settings']);

    // When: room for two.
    layout.setRoom(room(2));
    await settle();

    // Then: only the pinned account button and More are left.
    expect(inline('auth')).toBe(true);
    expect(await rowNames()).toEqual(['network', 'chat', 'permissions', 'theme', 'settings']);
  });

  it('As a phone user, the account button stays in the bar even when nothing fits', async () => {
    // When
    await renderTopbar(() => <Items />, 0.5 * ITEM_WIDTH);

    // Then
    expect(inline('auth')).toBe(true);
    expect(await rowNames()).not.toContain('auth');
  });

  it('As a phone user, the account ends the bar after the More button and never moves into More', async () => {
    // When
    await renderTopbar(() => <Items />, room(2), { end: () => <Item name="account" priority={PINNED} /> });

    // Then
    const account = byId('account-button');
    expect(byId('more-button').compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(inline('account')).toBe(true);
    expect(await rowNames()).not.toContain('account');
  });

  it('As a user widening the window, collapsed items come back and an open More menu closes with its last row', async () => {
    // Given
    const layout = await renderTopbar(() => <Items />, room(5));
    mouseClick(byId('more-button'));
    await settle();
    expect(isOpen()).toBe(true);
    expect(byId('more-button').getAttribute('aria-expanded')).toBe('true');

    // When
    layout.setRoom(room(6));
    await settle();

    // Then
    expect(inline('settings')).toBe(true);
    expect(inline('theme')).toBe(true);
    expect(moreShows()).toBe(false);
    expect(isOpen()).toBe(false);
    expect(byId('more-button').getAttribute('aria-expanded')).toBe('false');
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

  it('As a user watching the pill fold or reveal, the items stay put and fit again once it comes to rest', async () => {
    // Given: room for all six, while the pill morphs
    let morphing = true;
    const ends = new Set<() => void>();
    const layout = await renderTopbar(() => <Items />, room(6), {
      morph: {
        running: () => morphing,
        onEnd: listener => {
          ends.add(listener);
          return () => ends.delete(listener);
        },
      },
    });

    // When: the room shrinks mid-morph
    layout.setRoom(room(2));
    await settle();

    // Then
    expect(inline('settings')).toBe(true);

    // When: the morph ends
    morphing = false;
    for (const end of ends) {
      end();
    }
    await settle();

    // Then
    expect(inline('settings')).toBe(false);
    expect(inline('auth')).toBe(true);
  });

  it('As a user, a hidden item shows neither in the bar nor in More, and takes its share of the room once it shows', async () => {
    // Given: room for all but chat.
    const [chat, setChat] = createSignal(false);
    await renderTopbar(() => <Items chat={chat()} />, room(5));
    expect(inline('chat')).toBe(false);
    expect(moreShows()).toBe(false);

    // When
    setChat(true);
    await settle();

    // Then
    expect(inline('chat')).toBe(true);
    expect(await rowNames()).toEqual(['theme', 'settings']);
  });

  it('As a user, an item growing (a longer account badge) pushes others into More', async () => {
    // Given
    const layout = await renderTopbar(() => <Items />, room(6));

    // When
    layout.setWidth('auth', 2 * ITEM_WIDTH);
    await settle();

    // Then
    expect(await rowNames()).toEqual(['theme', 'settings']);
  });

  it('As a mobile user, choosing a row closes the menu, hands focus to More and activates the item with my tap', async () => {
    // Given
    await renderTopbar(() => <Items />, room(5));
    mouseClick(byId('more-button'));
    await settle();

    // When
    mouseClick(moreRow('theme'));
    await settle();

    // Then
    expect(activations).toEqual([{ name: 'theme', detail: 1 }]);
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(byId('more-button'));
  });

  it('As a keyboard user, choosing a row with a key activates the item with detail 0', async () => {
    // Given
    await renderTopbar(() => <Items />, room(4));
    await openMore();

    // When: a focused button turns Enter into a click with detail 0.
    moreRow('settings').click();
    await settle();

    // Then
    expect(activations).toEqual([{ name: 'settings', detail: 0 }]);
    expect(isOpen()).toBe(false);
  });

  it('As a screen-reader user, the More button announces its menu, and each row is a menu item with the item icon, label and a chevron', async () => {
    // When
    await renderTopbar(() => <Items />, room(5));

    // Then
    const button = byId('more-button');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-controls')).toBe('more-popover');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const popover = byId('more-popover');
    expect(popover.getAttribute('role')).toBe('menu');
    expect(popover.getAttribute('aria-label')).toBe('More');
    expect(button.getAttribute('aria-label')).toBe('More');
    expect(button.hasAttribute('data-badge')).toBe(false);
    await openMore();
    const row = moreRow('theme');
    expect(row.getAttribute('role')).toBe('menuitem');
    expect(row.getAttribute('tabindex')).toBe('-1');
    expect(row.textContent).toBe('THEME');
    expect(row.querySelector('svg[data-testid="icon-theme"]')).not.toBeNull();
    expect(row.lastElementChild?.getAttribute('data-testid')).toBe('more-row-chevron');
    expect(row.lastElementChild?.getAttribute('aria-hidden')).toBe('true');
  });

  it('As the build-time render, the items that may collapse are marked, and the More button is parked', async () => {
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
    expect(byTestId('more-item').hasAttribute('data-parked')).toBe(true);
  });

  it('As a user, a collapsed item stays in place, out of the tab order, so its surface keeps its anchor', async () => {
    // When
    await renderTopbar(() => <Items />, room(5));

    // Then
    const wrapper = byId('settings-button').parentElement;
    expect(wrapper?.hasAttribute('data-parked')).toBe(true);
    expect(byId('settings-button').isConnected).toBe(true);
  });

  it('As a user whose collapsed item raises a status, More carries it as its badge and in its name, until the status clears', async () => {
    // Given
    const [alert, setAlert] = createSignal<TopbarAlert | undefined>({ tone: 'warn', label: 'network unstable' });
    await renderTopbar(
      () => (
        <>
          <Item name="auth" priority={PINNED} />
          <Item name="network" priority={5} alert={alert()} />
          <Item name="settings" priority={1} />
        </>
      ),
      room(2),
    );

    // Then
    const more = byId('more-button');
    expect(await rowNames()).toEqual(['network', 'settings']);
    expect(more.hasAttribute('data-badge')).toBe(true);
    expect(more.getAttribute('data-tone')).toBe('warn');
    expect(more.getAttribute('aria-label')).toBe('More, network unstable');
    expect(byId('more-popover').getAttribute('aria-label')).toBe('More');

    // When
    setAlert(undefined);
    await settle();

    // Then
    expect(more.hasAttribute('data-badge')).toBe(false);
    expect(more.getAttribute('aria-label')).toBe('More');
  });

  it('As a desktop user with room for the item that raises a status, More raises nothing: the item shows its own', async () => {
    // When
    await renderTopbar(
      () => (
        <>
          <Item name="auth" priority={PINNED} />
          <Item name="network" priority={5} alert={{ tone: 'err', label: 'network offline' }} />
        </>
      ),
      room(4),
    );

    // Then
    expect(inline('network')).toBe(true);
    expect(byId('more-button').hasAttribute('data-badge')).toBe(false);
    expect(byId('more-button').getAttribute('aria-label')).toBe('More');
  });

  it('As a phone user with several collapsed items raising a status, I see the most severe one as More badge and hear every one in its name', async () => {
    // Given: the network still syncing (idle) ahead of unread chat (info)
    stubPhoneViewport(true);
    const [network, setNetwork] = createSignal<TopbarAlert | undefined>({ tone: 'idle', label: 'network syncing' });
    await renderTopbar(
      () => (
        <>
          <Item name="auth" priority={PINNED} />
          <Item name="network" priority={5} alert={network()} />
          <Item name="chat" priority={4} alert={{ tone: 'info', label: 'chat has unread messages' }} aside="3" />
        </>
      ),
      room(1),
    );

    // Then
    const more = byId('more-button');
    expect(more.getAttribute('data-tone')).toBe('info');
    expect(more.getAttribute('aria-label')).toBe('More, network syncing, chat has unread messages');
    await openMore();
    expect(byTestId('more-row-aside', moreRow('chat')).textContent).toBe('3');
    expect(moreRow('network').querySelector('[data-testid="more-row-aside"]')).toBeNull();

    // When
    setNetwork({ tone: 'err', label: 'network offline' });
    await settle();

    // Then
    expect(more.getAttribute('data-tone')).toBe('err');
    expect(more.getAttribute('aria-label')).toBe('More, network offline, chat has unread messages');
  });

  it('As a phone user, More opens as a bottom sheet titled More over a scrim, and a tap on the scrim closes it', async () => {
    // Given
    stubPhoneViewport(true);
    await renderTopbar(() => <Items />, room(4));

    // When
    mouseClick(byId('more-button'));
    await settle();

    // Then
    const sheet = byId('more-popover', HTMLDialogElement);
    expect(sheet.open).toBe(true);
    expect(isOpen()).toBe(true);
    expect(byId('topbar-actions').contains(sheet)).toBe(false);
    expect(byTestId('menu-sheet-title', sheet).textContent).toBe('More');
    expect(byTestId('menu-sheet-body', sheet).getAttribute('role')).toBe('menu');
    expect(await rowNames()).toEqual(['permissions', 'theme', 'settings']);

    // When
    mouseClick(byTestId('menu-scrim'));
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(sheet.open).toBe(false);
    expect(document.activeElement).toBe(byId('more-button'));
  });

  it('As a keyboard user on a phone-width window, a key on More opens the sheet on its first row, and the head is no stop for the arrows', async () => {
    // Given
    stubPhoneViewport(true);
    await renderTopbar(() => <Items />, room(4));

    // When: a focused button turns Enter into a click with detail 0.
    byId('more-button').click();
    await settle();

    // Then
    expect(byId('more-popover', HTMLDialogElement).open).toBe(true);
    expect(document.activeElement).toBe(moreRow('permissions'));

    // When
    await pressKey('ArrowUp');

    // Then
    expect(document.activeElement).toBe(moreRow('settings'));
  });
});
