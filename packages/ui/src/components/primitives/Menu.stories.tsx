// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { isPhoneViewport } from '../../phone-viewport.js';
import { Menu, MenuRow } from './Menu.js';

type MenuArgs = Parameters<typeof Menu>[0];

/** A menu that stays open, as a sheet or not: the story is the menu, not its trigger. */
const shown = (sheet: boolean): MenuArgs['popover'] => ({
  open: () => true,
  sheet: () => sheet,
  handedOff: () => false,
  setOpen: fn().mockName('setOpen'),
});

const meta = {
  title: 'Primitives/Menu',
  component: Menu,
  // Own docs iframes, since every menu is fixed to the top right of its page.
  parameters: { docs: { story: { inline: false, height: '260px' } } },
  args: { id: 'story-menu', popover: shown(false), label: 'More', ref: () => undefined, children: <></> },
} satisfies Meta<typeof Menu>;

export default meta;
type Story = StoryObj<typeof meta>;

// The Appearance menu's glyphs, which ThemeToggle.tsx keeps to itself.
const SunGlyph = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </svg>
);
const MoonGlyph = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </svg>
);
const MonitorGlyph = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect x="2" y="3" width="20" height="14" rx="3" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

const onRow = fn<(row: string) => void>().mockName('onRow');

// Menu calls its `ref` once while rendering. A ref reaching it through a spread
// is a reactive read there, so it is a static prop and the rest are explicit.
const noRef = (): void => undefined;
const rows = (args: MenuArgs) => (
  <Menu ref={noRef} id={args.id} popover={args.popover} label="More">
    <MenuRow
      testId="row-network"
      onClick={() => {
        onRow('network');
      }}
    >
      Network
    </MenuRow>
    <MenuRow
      testId="row-permissions"
      onClick={() => {
        onRow('permissions');
      }}
    >
      Permissions
    </MenuRow>
    <MenuRow
      testId="row-settings"
      onClick={() => {
        onRow('settings');
      }}
    >
      Settings
    </MenuRow>
  </Menu>
);

export const Rows: Story = {
  render: rows,
  play: async ({ canvas, userEvent, step }) => {
    onRow.mockClear();
    await step('When I press the Settings row', async () => {
      await userEvent.click(canvas.getByRole('menuitem', { name: 'Settings' }));
    });
    await step('Then the row reports it', async () => {
      await expect(onRow).toHaveBeenCalledWith('settings');
    });
  },
};

export const RadioRows: Story = {
  render: args => (
    <Menu ref={noRef} id={args.id} popover={args.popover} label="Appearance">
      <MenuRow role="menuitemradio" checked>
        System
      </MenuRow>
      <MenuRow role="menuitemradio" checked={false}>
        Light
      </MenuRow>
      <MenuRow role="menuitemradio" checked={false}>
        Dark
      </MenuRow>
    </Menu>
  ),
};

// Menu gives the row its keys and name, and the consumer lays the items out.
export const Horizontal: Story = {
  args: { orientation: 'horizontal' },
  render: args => (
    <Menu ref={noRef} id={args.id} popover={args.popover} label="Appearance" orientation={args.orientation}>
      <div role="group" style={{ display: 'flex', gap: '4px' }}>
        <MenuRow role="menuitemradio" checked={false}>
          <SunGlyph />
          <span>Light</span>
        </MenuRow>
        <MenuRow role="menuitemradio" checked>
          <MoonGlyph />
          <span>Dark</span>
        </MenuRow>
        <MenuRow role="menuitemradio" checked={false}>
          <MonitorGlyph />
          <span>System</span>
        </MenuRow>
      </div>
    </Menu>
  ),
};

export const Sheet: Story = {
  // A docs iframe renders at the column's width, never the phone's.
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  args: { popover: shown(true) },
  render: rows,
  play: async ({ args, canvas, userEvent, step }) => {
    // The workshop sizes its frame for the story's viewport only after the
    // first render, so the play waits for it.
    await step('Given the phone viewport', async () => {
      await waitFor(() => expect(isPhoneViewport()).toBe(true));
    });
    await step('Given the menu opens as a sheet titled More', async () => {
      await expect(canvas.getByTestId('menu-sheet-title')).toHaveTextContent('More');
    });
    await step('When I press the sheet close button', async () => {
      await userEvent.click(canvas.getByTestId('menu-sheet-close'));
    });
    await step('Then the menu is dismissed', async () => {
      await expect(args.popover.setOpen).toHaveBeenCalledOnce();
      await expect(args.popover.setOpen).toHaveBeenCalledWith(false);
    });
  },
};
