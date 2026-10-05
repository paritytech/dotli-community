// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { Menu, MenuRow } from './Menu.js';

const meta = {
  title: 'Primitives/Menu',
  component: Menu,
  parameters: { layout: 'fullscreen' },
  args: { id: 'story-menu', open: true, label: 'More', ref: () => undefined, onDismiss: fn(), children: <></> },
} satisfies Meta<typeof Menu>;

export default meta;
type Story = StoryObj<typeof meta>;
type MenuArgs = Parameters<typeof Menu>[0];

const onRow = fn((_row: string): void => {
  /* spy only */
});

// Menu calls its `ref` once while rendering. A ref reaching it through a spread
// is a reactive read there, so it is a static prop and the rest are explicit.
const noRef = (): void => undefined;
const rows = (args: MenuArgs) => (
  <Menu
    ref={noRef}
    id={args.id}
    open={args.open}
    label="More"
    sheet={args.sheet}
    sheetTitle={args.sheetTitle}
    onDismiss={args.onDismiss}
  >
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
    <Menu ref={noRef} id={args.id} open={args.open} label="Appearance">
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

export const Sheet: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  args: { sheet: true, sheetTitle: 'More' },
  render: rows,
  play: async ({ args, canvas, userEvent, step }) => {
    await step('Given the menu opens as a sheet titled More', async () => {
      await expect(canvas.getByTestId('menu-sheet-title')).toHaveTextContent('More');
    });
    await step('When I press the sheet close button', async () => {
      await userEvent.click(canvas.getByTestId('menu-sheet-close'));
    });
    await step('Then the menu is dismissed', async () => {
      await expect(args.onDismiss).toHaveBeenCalledOnce();
    });
  },
};
