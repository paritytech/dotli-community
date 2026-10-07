// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { IconButton } from '../primitives/IconButton.js';
import { BottomSheet } from './BottomSheet.js';
import { DropdownMenu } from './DropdownMenu.js';

const onRow = fn<(row: string) => void>().mockName('onRow');
// The menu is portalled into the body, outside the story's canvas.
const body = within(document.body);

function Harness() {
  // What the Settings row opens: on a phone, a sheet that takes the menu's place.
  const [settings, setSettings] = createSignal(false);
  const [trigger, setTrigger] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  return (
    <div style={{ display: 'flex', 'justify-content': 'flex-end' }}>
      <IconButton ref={setTrigger} id="story-more" aria-label="More" testId="story-more">
        …
      </IconButton>
      <DropdownMenu id="story-menu" title="More" trigger={trigger()}>
        <DropdownMenu.Item
          testId="row-network"
          onSelect={() => {
            onRow('network');
          }}
        >
          Network
        </DropdownMenu.Item>
        <DropdownMenu.Item
          testId="row-permissions"
          onSelect={() => {
            onRow('permissions');
          }}
        >
          Permissions
        </DropdownMenu.Item>
        <DropdownMenu.Item
          testId="row-settings"
          onSelect={() => {
            onRow('settings');
            setSettings(true);
          }}
        >
          Settings
        </DropdownMenu.Item>
      </DropdownMenu>
      <BottomSheet open={settings()} onOpenChange={setSettings} title="Settings" id="story-settings" testId="settings">
        <p style={{ padding: '0 20px' }}>Settings</p>
      </BottomSheet>
    </div>
  );
}

const meta = {
  title: 'Floating/DropdownMenu',
  component: Harness,
  parameters: { chrome: true, docs: { story: { inline: false, height: '260px' } } },
  tags: ['!autodocs'],
  beforeEach: () => {
    onRow.mockClear();
  },
} satisfies Meta<typeof Harness>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Trusted input, a user's: the browser's invokers act on it only. Loaded on
 * use, so the stories still load in Storybook outside Vitest.
 */
const input = async () => (await import('vitest/browser')).userEvent;
const menu = (): HTMLElement => {
  const el = document.getElementById('story-menu');
  if (el === null) {
    throw new Error('No #story-menu');
  }
  return el;
};
const row = (testId: string) => body.getByTestId(testId);

export const KeyboardOpensOnFirstItem: Story = {
  play: async ({ step }) => {
    await step('When I focus More and press Enter', async () => {
      body.getByTestId('story-more').focus();
      await (await input()).keyboard('{Enter}');
    });
    await step('Then the menu is open on Network', async () => {
      await waitFor(() => expect(menu()).toHaveAttribute('data-open'));
      await expect(menu()).toHaveAttribute('role', 'menu');
      await expect(body.getByTestId('story-more')).toHaveAttribute('aria-expanded', 'true');
      await waitFor(() => expect(row('row-network')).toHaveFocus());
    });
    await step('When I press ArrowUp', async () => {
      await (await input()).keyboard('{ArrowUp}');
    });
    await step('Then focus wrapped to Settings', async () => {
      await expect(row('row-settings')).toHaveFocus();
    });
    await step('When I type p', async () => {
      await (await input()).keyboard('p');
    });
    await step('Then typeahead moved to Permissions', async () => {
      await expect(row('row-permissions')).toHaveFocus();
    });
    await step('When I press Tab', async () => {
      await (await input()).keyboard('{Tab}');
    });
    await step('Then focus stayed on Permissions', async () => {
      await expect(row('row-permissions')).toHaveFocus();
    });
    await step('When I press Enter', async () => {
      await (await input()).keyboard('{Enter}');
    });
    await step('Then Permissions was chosen, the menu closed and More has focus', async () => {
      await expect(onRow).toHaveBeenCalledWith('permissions');
      await waitFor(() => expect(menu()).not.toHaveAttribute('data-open'));
      await expect(body.getByTestId('story-more')).toHaveFocus();
    });
  },
};

export const ArrowDownOpensOnFirstItem: Story = {
  play: async ({ step }) => {
    await step('When I focus More and press ArrowDown', async () => {
      body.getByTestId('story-more').focus();
      await (await input()).keyboard('{ArrowDown}');
    });
    await step('Then the menu is open on Network', async () => {
      await waitFor(() => expect(menu()).toHaveAttribute('data-open'));
      await waitFor(() => expect(row('row-network')).toHaveFocus());
    });
    await step('When I press End, then Escape', async () => {
      await (await input()).keyboard('{End}');
      await expect(row('row-settings')).toHaveFocus();
      await (await input()).keyboard('{Escape}');
    });
    await step('Then the menu closed, nothing was chosen and More has focus', async () => {
      await waitFor(() => expect(menu()).not.toHaveAttribute('data-open'));
      await expect(onRow).not.toHaveBeenCalled();
      await waitFor(() => expect(body.getByTestId('story-more')).toHaveFocus());
    });
  },
};

export const PointerOpensOnTheMenu: Story = {
  play: async ({ step }) => {
    await step('When I click More', async () => {
      await (await input()).click(body.getByTestId('story-more'));
    });
    await step('Then the menu itself has focus', async () => {
      await waitFor(() => expect(menu()).toHaveAttribute('data-open'));
      await waitFor(() => expect(menu()).toHaveFocus());
    });
    await step('When I hover Permissions', async () => {
      await (await input()).hover(row('row-permissions'));
    });
    await step('Then Permissions has focus', async () => {
      await waitFor(() => expect(row('row-permissions')).toHaveFocus());
    });
    await step('When I click More again', async () => {
      await (await input()).click(body.getByTestId('story-more'));
    });
    await step('Then the menu closed', async () => {
      await waitFor(() => expect(menu()).not.toHaveAttribute('data-open'));
      await expect(body.getByTestId('story-more')).toHaveAttribute('aria-expanded', 'false');
    });
  },
};

export const Sheet: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ step }) => {
    await step('When I tap More on a phone', async () => {
      await (await input()).click(body.getByTestId('story-more'));
    });
    await step('Then a sheet titled More holds the rows as a menu, which has focus', async () => {
      await waitFor(() => expect(body.getByTestId('menu-sheet-title')).toHaveTextContent('More'));
      await expect(menu()).toHaveAttribute('data-open');
      const sheetBody = body.getByTestId('menu-sheet-body');
      await expect(sheetBody).toHaveAttribute('role', 'menu');
      await expect(sheetBody).toHaveAccessibleName('More');
      await expect(within(sheetBody).getAllByRole('menuitem')).toHaveLength(3);
      await waitFor(() => expect(sheetBody).toHaveFocus());
    });
    await step('When I press ArrowDown', async () => {
      await (await input()).keyboard('{ArrowDown}');
    });
    await step('Then Network has focus', async () => {
      await expect(row('row-network')).toHaveFocus();
    });
  },
};

export const SheetRowHandsOff: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ step }) => {
    await step('Given the More sheet is open', async () => {
      await (await input()).click(body.getByTestId('story-more'));
      await waitFor(() => expect(menu()).toHaveAttribute('data-open'));
    });
    await step('When I tap the Settings row, which opens a sheet', async () => {
      await (await input()).click(row('row-settings'));
    });
    await step("Then the Settings sheet took More's place: both marked as a hand-off", async () => {
      await expect(onRow).toHaveBeenCalledWith('settings');
      const settings = document.getElementById('story-settings');
      await waitFor(() => expect(settings).toHaveAttribute('data-open'));
      await expect(settings).toHaveAttribute('data-open');
      await expect(settings).toHaveAttribute('data-handoff');
      await expect(menu()).not.toHaveAttribute('data-open');
      await expect(menu()).not.toHaveAttribute('data-open');
      await expect(menu()).toHaveAttribute('data-handoff');
    });
    await step('And focus is in the Settings sheet, not back on More', async () => {
      await new Promise(resolve => requestAnimationFrame(resolve));
      await expect(document.getElementById('story-settings')?.contains(document.activeElement)).toBe(true);
    });
    await step('When I press Escape', async () => {
      await (await input()).keyboard('{Escape}');
    });
    await step('Then focus is back on More, where it was before the menu opened', async () => {
      await waitFor(() => expect(document.getElementById('story-settings')).not.toHaveAttribute('data-open'));
      await waitFor(() => expect(body.getByTestId('story-more')).toHaveFocus());
    });
  },
};

export const SheetRowWithoutSheetSlides: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ step }) => {
    await step('Given the More sheet is open', async () => {
      await (await input()).click(body.getByTestId('story-more'));
      await waitFor(() => expect(menu()).toHaveAttribute('data-open'));
    });
    await step('When I tap the Network row, which opens no sheet', async () => {
      await (await input()).click(row('row-network'));
    });
    await step('Then More closed as usual, not marked as a hand-off, and More has focus', async () => {
      await expect(onRow).toHaveBeenCalledWith('network');
      await waitFor(() => expect(menu()).not.toHaveAttribute('data-open'));
      await expect(menu()).not.toHaveAttribute('data-handoff');
      await waitFor(() => expect(body.getByTestId('story-more')).toHaveFocus());
    });
  },
};
