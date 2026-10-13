// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import type { SolidRenderer } from 'storybook-solidjs-vite';
import type { StoryContext } from 'storybook/internal/types';
import { isPhoneViewport } from '../../page/phone-viewport.js';
import { ActionGroup, type ActionGroupMorph, type MoreIds } from './ActionGroup.js';
import { ActionItem } from './ActionItem.js';
import { ActionsContext, type ActionAlert, type ActionBar } from './actions-context.js';
import { PINNED } from './fit.js';
import { OverflowMenu } from './OverflowMenu.js';
import { GlobeIcon } from '../icons/GlobeIcon.js';

const GROUP = 'story-actions';
const MORE: MoreIds = { buttonId: 'more-button', menuId: 'more-popover' };

/** Every stand-in item's width, wider than More so a row's room always fits More in its place. */
const ITEM = 48;

interface Activation {
  name: string;
  detail: number;
}

const activations: Activation[] = [];
/** The room the bar gives the group, which a play changes and then announces with a resize, as a window would. */
const bar = { room: 10_000 };
const [chat, setChat] = createSignal(true);
const [networkAlert, setNetworkAlert] = createSignal<ActionAlert | undefined>(undefined);
const [authWidth, setAuthWidth] = createSignal(ITEM);
const morph = { running: false, ends: new Set<() => void>() };
const storyMorph: ActionGroupMorph = {
  running: () => morph.running,
  onEnd: listener => {
    morph.ends.add(listener);
    return () => morph.ends.delete(listener);
  },
};

function Item(props: {
  name: string;
  priority: number;
  visible?: boolean;
  alert?: ActionAlert | undefined;
  aside?: string | undefined;
  width?: number;
}): JSX.Element {
  return (
    <ActionItem
      name={props.name}
      label={props.name.toUpperCase()}
      icon={() => <GlobeIcon testId={`icon-${props.name}`} />}
      priority={props.priority}
      visible={props.visible ?? true}
      alert={props.alert}
      aside={props.aside === undefined ? undefined : () => props.aside}
      activate={ev => {
        activations.push({ name: props.name, detail: ev.detail });
      }}
    >
      <button id={`${props.name}-button`} type="button" style={{ width: `${String(props.width ?? ITEM)}px` }}>
        {props.name}
      </button>
    </ActionItem>
  );
}

function Items(): JSX.Element {
  return (
    <>
      <Item name="auth" priority={PINNED} width={authWidth()} />
      <Item name="network" priority={5} />
      <Item name="chat" priority={4} visible={chat()} />
      <Item name="permissions" priority={3} />
      <Item name="theme" priority={2} />
      <Item name="settings" priority={1} />
    </>
  );
}

/** A bar across the top of the page, as a page puts a group in one. */
function Bar(props: { children: JSX.Element }): JSX.Element {
  return (
    <header
      data-testid="story-bar"
      style={{
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        height: 'var(--topbar-height)',
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'flex-end',
        padding: '0 12px',
      }}
    >
      {props.children}
    </header>
  );
}

function Group(props: { children: JSX.Element; end?: JSX.Element }): JSX.Element {
  return (
    <Bar>
      <ActionGroup id={GROUP} more={MORE} room={() => bar.room} morph={storyMorph} end={props.end}>
        {props.children}
      </ActionGroup>
    </Bar>
  );
}

/** A row of the open More menu. */
function moreRow(name: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`#${MORE.menuId} [role="menuitem"][data-item="${name}"]`);
  if (row === null) {
    throw new Error(`No More row ${name}`);
  }
  return row;
}

/** The open More menu's rows, in order. */
function moreRowNames(): string[] {
  return [...document.querySelectorAll<HTMLElement>(`#${MORE.menuId} [role="menuitem"]`)].map(
    row => row.dataset['item'] ?? '',
  );
}

/** The phone variant's guard: the story's viewport really crossed the phone breakpoint. */
async function expectPhone(step: StoryContext<SolidRenderer>['step']): Promise<void> {
  await step('Given the phone viewport', async () => {
    await waitFor(() => expect(isPhoneViewport()).toBe(true));
  });
}

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`No #${id}`);
  }
  return found;
}

/** Gives the group room for `slots` items side by side, More counting as one, and lets it measure again. */
function fitSlots(slots: number): void {
  const gap = Number.parseFloat(getComputedStyle(el(GROUP)).columnGap);
  bar.room = slots * ITEM + (slots - 1) * gap;
  window.dispatchEvent(new Event('resize'));
}

function inline(name: string): boolean {
  const item = document.querySelector<HTMLElement>(`[data-testid="action-item"][data-item="${name}"]`);
  return item !== null && item.hidden === false && !item.hasAttribute('data-parked');
}

const moreShows = (): boolean =>
  document.querySelector('[data-testid="more-item"]')?.hasAttribute('data-parked') === false;
const isOpen = (): boolean => document.getElementById(MORE.menuId)?.hasAttribute('data-open') === true;
const ALL = ['auth', 'network', 'chat', 'permissions', 'theme', 'settings'];

const meta = {
  title: 'Primitives/ActionGroup',
  component: ActionGroup,
  // The bar's own Group builds the props, so the render ignores these.
  args: { children: undefined },
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  tags: ['!autodocs'],
  beforeEach: () => {
    activations.length = 0;
    bar.room = 10_000;
    morph.running = false;
    morph.ends.clear();
    setChat(true);
    setNetworkAlert(undefined);
    setAuthWidth(ITEM);
  },
  render: () => (
    <Group>
      <Items />
    </Group>
  ),
} satisfies Meta<typeof ActionGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Opens More by its button once it shows. */
async function openMore(userEvent: { click: (el: Element) => Promise<void> }): Promise<void> {
  await waitFor(() => expect(moreShows()).toBe(true));
  await userEvent.click(el(MORE.buttonId));
  await waitFor(() => expect(isOpen()).toBe(true));
}

/** As a desktop user, every item sits in the bar when there is room, and the More button stays out of the way. */
export const AllFit: Story = {
  play: async ({ step }) => {
    await step('Then every item is inline and More is parked', async () => {
      await waitFor(() => expect(el(GROUP)).toHaveAttribute('data-collapsible'));
      await expect(ALL.filter(inline)).toEqual(ALL);
      await expect(moreShows()).toBe(false);
    });
  },
};

/** As a user narrowing the window, items move into More lowest priority first, and the rows keep the bar order. */
export const NarrowingCollapsesInBarOrder: Story = {
  play: async ({ userEvent, step }) => {
    await step('When the bar has room for five, one of them More', () => {
      fitSlots(5);
    });
    await step('Then theme and settings moved into More, in bar order', async () => {
      await waitFor(() => expect(inline('theme')).toBe(false));
      await expect(inline('settings')).toBe(false);
      await expect(inline('permissions')).toBe(true);
      await openMore(userEvent);
      await expect(moreRowNames()).toEqual(['theme', 'settings']);
    });
    await step('When the bar has room for two', () => {
      fitSlots(2);
    });
    await step('Then only the pinned account and More are left', async () => {
      await waitFor(() => expect(inline('network')).toBe(false));
      await expect(inline('auth')).toBe(true);
      await waitFor(() => expect(moreRowNames()).toEqual(['network', 'chat', 'permissions', 'theme', 'settings']));
    });
  },
};

/** As a phone user, the account ends the bar after the More button and never moves into More. */
export const AccountEndsBar: Story = {
  render: () => (
    <Group end={<Item name="account" priority={PINNED} />}>
      <Items />
    </Group>
  ),
  play: async ({ userEvent, step }) => {
    await step('When the bar has room for two', () => {
      fitSlots(2);
    });
    await step('Then the account is inline after More and no row of it', async () => {
      await waitFor(() => expect(moreShows()).toBe(true));
      await expect(
        el(MORE.buttonId).compareDocumentPosition(el('account-button')) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      await expect(inline('account')).toBe(true);
      await openMore(userEvent);
      await expect(moreRowNames()).not.toContain('account');
    });
  },
};

/** As a user widening the window, collapsed items come back and an open More menu closes with its last row. */
export const WideningRestoresAndClosesMore: Story = {
  play: async ({ userEvent, step }) => {
    await step('Given More open with two rows', async () => {
      fitSlots(5);
      await openMore(userEvent);
      await expect(el(MORE.buttonId)).toHaveAttribute('aria-expanded', 'true');
    });
    await step('When the bar has room for every item', () => {
      fitSlots(6);
    });
    await step('Then the items are back, More is parked and its menu closed', async () => {
      await waitFor(() => expect(inline('settings')).toBe(true));
      await expect(inline('theme')).toBe(true);
      await expect(moreShows()).toBe(false);
      await waitFor(() => expect(isOpen()).toBe(false));
      await expect(el(MORE.buttonId)).toHaveAttribute('aria-expanded', 'false');
    });
  },
};

/** As a user widening the window, items that collapsed into More come back once the pill has room. */
export const PillWideningRestores: Story = {
  play: async ({ step }) => {
    await step('Given the pill gives room for two', async () => {
      fitSlots(2);
      await waitFor(() => expect(inline('settings')).toBe(false));
    });
    await step('When the window widens so the pill has room for all six', () => {
      fitSlots(6);
    });
    await step('Then every item is inline', async () => {
      await waitFor(() => expect(ALL.filter(inline)).toEqual(ALL));
    });
  },
};

/** As a user watching the pill fold or reveal, the items stay put and fit again once it comes to rest. */
export const MorphKeepsItems: Story = {
  play: async ({ step }) => {
    await step('Given every item inline while the pill morphs', async () => {
      await waitFor(() => expect(el(GROUP)).toHaveAttribute('data-collapsible'));
      morph.running = true;
    });
    await step('When the room shrinks mid-morph', () => {
      fitSlots(2);
    });
    await step('Then the items stay put', async () => {
      await expect(inline('settings')).toBe(true);
    });
    await step('When the morph ends', () => {
      morph.running = false;
      for (const end of morph.ends) {
        end();
      }
    });
    await step('Then they fit the new room', async () => {
      await waitFor(() => expect(inline('settings')).toBe(false));
      await expect(inline('auth')).toBe(true);
    });
  },
};

/** As a user, a hidden item shows neither in the bar nor in More, and takes its share of the room once it shows. */
export const HiddenItem: Story = {
  beforeEach: () => {
    setChat(false);
  },
  play: async ({ userEvent, step }) => {
    await step('Given room for all but chat', async () => {
      fitSlots(5);
      await waitFor(() => expect(el(GROUP)).toHaveAttribute('data-collapsible'));
      await expect(inline('chat')).toBe(false);
      await waitFor(() => expect(inline('settings')).toBe(true));
      await expect(moreShows()).toBe(false);
    });
    await step('When chat shows', () => {
      setChat(true);
    });
    await step('Then chat is inline and pushed the two lowest into More', async () => {
      await waitFor(() => expect(inline('chat')).toBe(true));
      await openMore(userEvent);
      await expect(moreRowNames()).toEqual(['theme', 'settings']);
    });
  },
};

/** As a user, an item growing (a longer account badge) pushes others into More. */
export const GrowingItem: Story = {
  play: async ({ userEvent, step }) => {
    await step('Given room for every item', async () => {
      fitSlots(6);
      await waitFor(() => expect(inline('settings')).toBe(true));
    });
    await step('When the account grows to twice its width', () => {
      setAuthWidth(2 * ITEM);
    });
    await step('Then theme and settings moved into More', async () => {
      await waitFor(() => expect(inline('settings')).toBe(false));
      await openMore(userEvent);
      await expect(moreRowNames()).toEqual(['theme', 'settings']);
    });
  },
};

/** As a mobile user, choosing a row closes the menu, hands focus to More and activates the item with my tap. */
export const RowTapActivates: Story = {
  play: async ({ userEvent, step }) => {
    await step('Given More open', async () => {
      fitSlots(5);
      await openMore(userEvent);
    });
    await step('When I tap the theme row', async () => {
      await userEvent.click(moreRow('theme'));
    });
    await step('Then theme was activated with my tap, the menu closed and More has focus', async () => {
      await waitFor(() => expect(activations).toEqual([{ name: 'theme', detail: 1 }]));
      await waitFor(() => expect(isOpen()).toBe(false));
      await expect(el(MORE.buttonId)).toHaveFocus();
    });
  },
};

/** As a keyboard user, choosing a row with a key activates the item with detail 0. */
export const RowKeyActivates: Story = {
  play: async ({ userEvent, step }) => {
    await step('Given More open on the settings row', async () => {
      fitSlots(4);
      await openMore(userEvent);
      moreRow('settings').focus();
    });
    await step('When I press Enter', async () => {
      await userEvent.keyboard('{Enter}');
    });
    await step('Then settings was activated with detail 0 and the menu closed', async () => {
      await waitFor(() => expect(activations).toEqual([{ name: 'settings', detail: 0 }]));
      await waitFor(() => expect(isOpen()).toBe(false));
    });
  },
};

/** As a screen-reader user, More announces its menu, and each row is a menu item with the item icon, label and a chevron. */
export const MoreAria: Story = {
  play: async ({ userEvent, step }) => {
    const button = (): HTMLElement => el(MORE.buttonId);
    await step('Then More announces its closed menu with no badge', async () => {
      fitSlots(5);
      await waitFor(() => expect(moreShows()).toBe(true));
      await expect(button()).toHaveAttribute('aria-haspopup', 'menu');
      await expect(button()).toHaveAttribute('aria-controls', MORE.menuId);
      await expect(button()).toHaveAttribute('aria-expanded', 'false');
      await expect(button()).toHaveAttribute('aria-label', 'More');
      await expect(button()).not.toHaveAttribute('data-badge');
    });
    await step('When I open it', async () => {
      await openMore(userEvent);
    });
    await step('Then it is a menu named More, and the theme row a menu item with icon, label and chevron', async () => {
      await expect(el(MORE.menuId)).toHaveAttribute('role', 'menu');
      await expect(el(MORE.menuId)).toHaveAttribute('aria-label', 'More');
      const row = moreRow('theme');
      await expect(row).toHaveAttribute('role', 'menuitem');
      await expect(row).toHaveAttribute('tabindex', '-1');
      await expect(row.textContent).toBe('THEME');
      await expect(row.querySelector('svg[data-testid="icon-theme"]')).not.toBeNull();
      await expect(row.lastElementChild).toHaveAttribute('data-testid', 'more-row-chevron');
      await expect(row.lastElementChild).toHaveAttribute('aria-hidden', 'true');
    });
  },
};

/** A group that has not measured yet, as in a build-time render. */
const unmeasured: ActionBar = {
  register: () => () => false,
  observe: () => undefined,
  moreButton: () => undefined,
};

/** As the build-time render, the More button is parked. */
export const BuildTimeMoreParked: Story = {
  render: () => (
    <ActionsContext value={unmeasured}>
      <Items />
      <OverflowMenu rows={[]} buttonRef={() => undefined} buttonId={MORE.buttonId} menuId={MORE.menuId} />
    </ActionsContext>
  ),
  play: async ({ canvasElement, step }) => {
    await step('Then More is parked', async () => {
      await expect(within(canvasElement).getByTestId('more-item')).toHaveAttribute('data-parked');
    });
  },
};

/** As a user, a collapsed item stays in place, out of the tab order, so its surface keeps its anchor. */
export const CollapsedKeepsAnchor: Story = {
  play: async ({ step }) => {
    await step('When settings collapses', async () => {
      fitSlots(5);
      await waitFor(() => expect(inline('settings')).toBe(false));
    });
    await step('Then its button is still in the page, in its parked wrapper', async () => {
      await expect(el('settings-button').parentElement).toHaveAttribute('data-parked');
      await expect(el('settings-button').isConnected).toBe(true);
    });
  },
};

function AlertItems(props: { aside?: boolean }): JSX.Element {
  return (
    <>
      <Item name="auth" priority={PINNED} />
      <Item name="network" priority={5} alert={networkAlert()} />
      <Item
        name="chat"
        priority={4}
        visible={props.aside === true}
        alert={{ tone: 'info', label: 'chat has unread messages' }}
        aside="3"
      />
      <Item name="settings" priority={1} />
    </>
  );
}

/** As a user whose collapsed item raises a status, More carries it as its badge and in its name, until it clears. */
export const MoreBadgeAndName: Story = {
  beforeEach: () => {
    setNetworkAlert({ tone: 'warn', label: 'network unstable' });
  },
  render: () => (
    <Group>
      <AlertItems />
    </Group>
  ),
  play: async ({ userEvent, step }) => {
    const more = (): HTMLElement => el(MORE.buttonId);
    await step('When network and settings collapse', async () => {
      fitSlots(2);
      await openMore(userEvent);
      await expect(moreRowNames()).toEqual(['network', 'settings']);
    });
    await step("Then More carries the network's warning as its badge and in its name", async () => {
      await expect(more()).toHaveAttribute('data-badge');
      await expect(more()).toHaveAttribute('data-tone', 'warn');
      await expect(more()).toHaveAttribute('aria-label', 'More, network unstable');
      await expect(el(MORE.menuId)).toHaveAttribute('aria-label', 'More');
    });
    await step('When the status clears', () => {
      setNetworkAlert(undefined);
    });
    await step('Then More has no badge and is named More', async () => {
      await waitFor(() => expect(more()).not.toHaveAttribute('data-badge'));
      await expect(more()).toHaveAttribute('aria-label', 'More');
    });
  },
};

/** As a desktop user with room for the item that raises a status, More raises nothing: the item shows its own. */
export const NoBadgeWhenItemShows: Story = {
  beforeEach: () => {
    setNetworkAlert({ tone: 'err', label: 'network offline' });
  },
  render: () => (
    <Group>
      <AlertItems />
    </Group>
  ),
  play: async ({ step }) => {
    await step('Given room for every item', async () => {
      await waitFor(() => expect(el(GROUP)).toHaveAttribute('data-collapsible'));
    });
    await step('Then network is inline and More raises nothing', async () => {
      await expect(inline('network')).toBe(true);
      await expect(el(MORE.buttonId)).not.toHaveAttribute('data-badge');
      await expect(el(MORE.buttonId)).toHaveAttribute('aria-label', 'More');
    });
  },
};

/** As a phone user with several collapsed items raising a status, More shows the most severe as its badge and its row shows the aside. */
export const PhoneSeveralAlerts: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  beforeEach: () => {
    setNetworkAlert({ tone: 'idle', label: 'network syncing' });
  },
  render: () => (
    <Group>
      <AlertItems aside />
    </Group>
  ),
  play: async ({ userEvent, step }) => {
    await expectPhone(step);
    const more = (): HTMLElement => el(MORE.buttonId);
    await step('When everything but the account collapses', async () => {
      fitSlots(1);
      await openMore(userEvent);
    });
    await step('Then More shows unread chat, the most severe, and names both, and the chat row its count', async () => {
      await expect(more()).toHaveAttribute('data-tone', 'info');
      await expect(more()).toHaveAttribute('aria-label', 'More, network syncing, chat has unread messages');
      await expect(within(moreRow('chat')).getByTestId('more-row-aside')).toHaveTextContent('3');
      await expect(moreRow('network').querySelector('[data-testid="more-row-aside"]')).toBeNull();
    });
    await step('When the network goes offline', () => {
      setNetworkAlert({ tone: 'err', label: 'network offline' });
    });
    await step('Then More shows the error', async () => {
      await waitFor(() => expect(more()).toHaveAttribute('data-tone', 'err'));
      await expect(more()).toHaveAttribute('aria-label', 'More, network offline, chat has unread messages');
    });
  },
};

/** As a phone user, More opens as a bottom sheet titled More over a scrim, and a tap on the scrim closes it. */
export const PhoneSheetOverScrim: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ userEvent, step }) => {
    await expectPhone(step);
    await step('When I tap More with three rows', async () => {
      fitSlots(4);
      await openMore(userEvent);
    });
    await step('Then it is a sheet titled More outside the bar, with a menu body', async () => {
      const sheet = el(MORE.menuId);
      await expect(el(GROUP).contains(sheet)).toBe(false);
      await expect(within(sheet).getByTestId('menu-sheet-title')).toHaveTextContent('More');
      await expect(within(sheet).getByTestId('menu-sheet-body')).toHaveAttribute('role', 'menu');
      await expect(moreRowNames()).toEqual(['permissions', 'theme', 'settings']);
    });
    await step('When I tap the scrim', async () => {
      await userEvent.click(within(document.body).getByTestId('menu-scrim'));
    });
    await step('Then the sheet closed and More has focus', async () => {
      await waitFor(() => expect(isOpen()).toBe(false));
      await waitFor(() => expect(el(MORE.buttonId)).toHaveFocus());
    });
  },
};

/** As a keyboard user on a phone-width window, a key on More opens the sheet on its first row, and the head is no stop for the arrows. */
export const PhoneKeyOpensOnFirstRow: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ userEvent, step }) => {
    await expectPhone(step);
    await step('When I press Enter on More', async () => {
      fitSlots(4);
      await waitFor(() => expect(moreShows()).toBe(true));
      el(MORE.buttonId).focus();
      await userEvent.keyboard('{Enter}');
    });
    await step('Then the sheet is open on its first row', async () => {
      await waitFor(() => expect(isOpen()).toBe(true));
      await waitFor(() => expect(moreRow('permissions')).toHaveFocus());
    });
    await step('When I press ArrowUp', async () => {
      await userEvent.keyboard('{ArrowUp}');
    });
    await step('Then focus wrapped to the last row, past the head', async () => {
      await expect(moreRow('settings')).toHaveFocus();
    });
  },
};

/** The rows the group asked its room against, in order. */
const roomRows: (HTMLElement | null)[] = [];

/** As an action group hydrated inside an island's box-less wrapper, I measure my room against the bar's row. */
export const RowPastIslandWrapper: Story = {
  beforeEach: () => {
    roomRows.length = 0;
  },
  render: () => (
    <Bar>
      <div style={{ display: 'contents' }}>
        <ActionGroup
          id={GROUP}
          more={MORE}
          room={(_group, row) => {
            roomRows.push(row);
            return 10_000;
          }}
        >
          <Items />
        </ActionGroup>
      </div>
    </Bar>
  ),
  play: async ({ canvasElement, step }) => {
    await step('Then the group measured, and asked its room against the bar, not the wrapper', async () => {
      await waitFor(() => expect(el(GROUP)).toHaveAttribute('data-measured'));
      await expect(roomRows.length).toBeGreaterThan(0);
      await expect(roomRows.at(-1)).toBe(within(canvasElement).getByTestId('story-bar'));
    });
  },
};
