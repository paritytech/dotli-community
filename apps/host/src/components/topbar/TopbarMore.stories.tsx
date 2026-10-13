// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { byId, query } from '@dotli/ui/testing';
import type { PermissionStatus } from '../../runtime/permissions.js';
import { expectPhone, openSurface, reachable } from '../../../.storybook/topbar-frame.js';
import { GroupFrame, moreRow, openMore } from '../../../.storybook/frames.js';
import {
  givenApp,
  resetStoryPermissions,
  STORY_PERMISSIONS,
  storyPermissions,
} from '../../../.storybook/permissions-fixtures.js';
import {
  DEFAULT_SETTINGS,
  givenSettings,
  resetStorySettings,
  storySettings,
} from '../../../.storybook/settings-fixtures.js';
import { resetStoryNetwork, setHealth, storyNetwork } from '../../../.storybook/network-fixtures.js';
import { NetworkItem, PermissionsItem, SettingsItem } from './items.js';

function StoryPermissions(): JSX.Element {
  return <PermissionsItem {...storyPermissions} />;
}

const open = openSurface({ trigger: 'more-button', surface: 'more-popover' });

const settingsOpen = (): boolean => document.getElementById('mode-popover')?.hasAttribute('data-open') === true;

const STATUSES: readonly PermissionStatus[] = ['ask', 'granted', 'denied'];

/** Which status a permission's row has pressed. */
function statusOf(name: string): PermissionStatus | undefined {
  const row = byId(`permissions-popover-name-${name}`).closest<HTMLElement>('[data-testid="permissions-popover-row"]');
  if (row === null) {
    throw new Error(`No ${name} row`);
  }
  return STATUSES.find(
    status => within(row).getByTestId(`permissions-popover-segment-${status}`).getAttribute('aria-pressed') === 'true',
  );
}

const meta = {
  title: 'Host/Topbar/More',
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  beforeEach: () => {
    resetStoryNetwork();
    resetStoryPermissions();
    resetStorySettings();
    // An app is loaded, so the permissions panel lists its permissions.
    givenApp();
  },
  render: () => (
    <GroupFrame room={40}>
      <NetworkItem {...storyNetwork} />
      <StoryPermissions />
      <SettingsItem {...storySettings} />
    </GroupFrame>
  ),
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    await open(ctx);
  },
};

export const OpenPhone: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ctx => {
    await expectPhone(ctx.step);
    await open(ctx);
  },
};

export const RowOpensCollapsedPopover: Story = {
  tags: ['!autodocs'],
  play: async ({ userEvent, step }) => {
    await step('Given More is open', async () => {
      await userEvent.click(query(document, '#more-button'));
      await waitFor(() => expect(document.getElementById('more-popover')).toHaveAttribute('data-open'));
    });
    await step('When I choose the Settings row', async () => {
      await userEvent.click(query(document, '#more-popover [data-item="settings"]'));
    });
    await step('Then Settings is open under the topbar and More is closed', async () => {
      await waitFor(() => expect(document.getElementById('mode-popover')).toHaveAttribute('data-open'));
      await expect(document.getElementById('more-popover')).not.toHaveAttribute('data-open');
    });
    await step('When I press Escape', async () => {
      await userEvent.keyboard('{Escape}');
    });
    await step('Then focus is on More, since the Settings button is collapsed', async () => {
      await waitFor(() => expect(document.getElementById('more-button')).toHaveFocus());
    });
  },
};

/** As a phone user choosing Permissions in More before any popover opened, the permissions sheet takes More's place. */
export const PhoneRowFirstOpening: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  render: () => (
    <GroupFrame room={40}>
      <StoryPermissions />
    </GroupFrame>
  ),
  play: async ({ userEvent, step }) => {
    await expectPhone(step);
    await step('Given Permissions collapsed into More and More open', async () => {
      await reachable(query(document, '#more-button'));
      await userEvent.click(query(document, '#more-button'));
      await waitFor(() => expect(query(document, '#more-popover')).toHaveAttribute('data-open'));
    });
    await step('When I tap the Permissions row', async () => {
      await userEvent.click(query(document, '#more-popover [role="menuitem"][data-item="permissions"]'));
    });
    await step("Then Permissions took More's place, both marked as a hand-off", async () => {
      const sheet = query(document, '#permissions-popover');
      await waitFor(() => expect(sheet).toHaveAttribute('data-open'));
      await expect(sheet).toHaveAttribute('data-handoff');
      const more = query(document, '#more-popover');
      await expect(more).not.toHaveAttribute('data-open');
      await expect(more).toHaveAttribute('data-handoff');
    });
  },
};

/** As a mobile user, the More menu's Permissions row opens the permissions popover with its content. */
export const PermissionsRowOpens: Story = {
  tags: ['!autodocs'],
  play: async ({ userEvent, step }) => {
    await step('Given More is open', async () => {
      await reachable(query(document, '#more-button'));
      await userEvent.click(query(document, '#more-button'));
      await waitFor(() => expect(document.getElementById('more-popover')).toHaveAttribute('data-open'));
    });
    await step('When I choose the Permissions row', async () => {
      await userEvent.click(query(document, '#more-popover [data-item="permissions"]'));
    });
    await step('Then More closed and Permissions is open with its content', async () => {
      await waitFor(() => expect(document.getElementById('permissions-popover')).toHaveAttribute('data-open'));
      await expect(document.getElementById('more-popover')).not.toHaveAttribute('data-open');
      await waitFor(() =>
        expect(query(document, '#permissions-popover [data-testid="permissions-popover-row"]')).toBeVisible(),
      );
    });
  },
};

/**
 * As a phone user with the permissions button in More, its row carries the grants mark while the app has a grant,
 * More raises none, and the row opens the panel with every permission and its status.
 */
export const PhoneRowMarksGrants: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  beforeEach: () => {
    givenApp({ Camera: 'granted' });
  },
  render: () => (
    <GroupFrame room={40}>
      <StoryPermissions />
    </GroupFrame>
  ),
  play: async ({ userEvent, step }) => {
    await expectPhone(step);
    await step('When I open More', async () => {
      await openMore(userEvent);
    });
    await step('Then the Permissions row carries the grants mark and More none', async () => {
      await expect(within(moreRow('permissions')).getByRole('img')).toHaveAttribute('aria-label', 'Has permissions');
      await expect(byId('more-button')).toHaveAttribute('aria-label', 'More');
    });
    await step('When the only grant goes back to Ask', () => {
      storyPermissions.onChoose('Camera', 'ask');
    });
    await step('Then the row has no mark', async () => {
      await waitFor(() => expect(moreRow('permissions').querySelector('[data-testid="more-row-aside"]')).toBeNull());
    });
    await step('When Camera is allowed again and I choose the Permissions row', async () => {
      storyPermissions.onChoose('Camera', 'granted');
      await userEvent.click(moreRow('permissions'));
    });
    await step("Then the panel took More's place with every permission, Camera pressed Allow", async () => {
      await waitFor(() => expect(byId('permissions-popover')).toHaveAttribute('data-open'));
      await waitFor(() =>
        expect(document.querySelectorAll('[data-testid="permissions-popover-row"]')).toHaveLength(
          STORY_PERMISSIONS.length,
        ),
      );
      await expect(statusOf('Camera')).toBe('granted');
    });
  },
};

/**
 * As a mobile user who opened the settings from the More menu, the sheet takes focus, and closing it by Close or
 * Escape hands focus back to the More button, since the settings button is collapsed.
 */
export const SettingsFromMoreHandsFocusBack: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  render: () => (
    <GroupFrame room={40}>
      <SettingsItem {...storySettings} />
    </GroupFrame>
  ),
  play: async ({ userEvent, step }) => {
    await expectPhone(step);
    const fromMore = async (): Promise<void> => {
      await openMore(userEvent);
      await userEvent.click(moreRow('settings'));
      await waitFor(() => expect(settingsOpen()).toBe(true));
    };
    await step('When I choose Settings in More', fromMore);
    await step("Then the sheet took More's place and has focus", async () => {
      await expect(byId('more-popover')).not.toHaveAttribute('data-open');
      await waitFor(() => expect(byId('mode-popover').contains(document.activeElement)).toBe(true));
    });
    await step('When I press Escape', async () => {
      await userEvent.keyboard('{Escape}');
    });
    await step('Then it closed and More has focus', async () => {
      await waitFor(() => expect(settingsOpen()).toBe(false));
      await waitFor(() => expect(byId('more-button')).toHaveFocus());
    });
    await step('When I open it from More again and press Close', async () => {
      await fromMore();
      await userEvent.click(query(document, '[data-testid="popover-sheet-close"]'));
    });
    await step('Then it closed and More has focus', async () => {
      await waitFor(() => expect(settingsOpen()).toBe(false));
      await waitFor(() => expect(byId('more-button')).toHaveFocus());
    });
  },
};

/** As a phone user with the settings button in More, its row carries the unverified mark while the session is unverified. */
export const PhoneRowMarksUnverified: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  beforeEach: () => {
    givenSettings({ ...DEFAULT_SETTINGS, backend: 'rpc-gateway', verified: false });
  },
  render: () => (
    <GroupFrame room={40}>
      <SettingsItem {...storySettings} />
    </GroupFrame>
  ),
  play: async ({ userEvent, step }) => {
    await expectPhone(step);
    await step('When I open More', async () => {
      await openMore(userEvent);
    });
    await step('Then the Settings row carries the unverified mark and More none', async () => {
      await expect(within(moreRow('settings')).getByRole('img')).toHaveAttribute('aria-label', 'Unverified session');
      await expect(byId('more-button')).toHaveAttribute('aria-label', 'More');
    });
    await step('When the settings read as a verified session', () => {
      givenSettings(DEFAULT_SETTINGS);
    });
    await step('Then the row has no mark', async () => {
      await waitFor(() => expect(moreRow('settings').querySelector('[data-testid="more-row-aside"]')).toBeNull());
    });
  },
};

/**
 * As a phone user with the network button in More, its row says the health in a word, and a warning raises More's
 * badge and its name.
 */
export const PhoneRowCarriesVerdict: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  render: () => (
    <GroupFrame room={40}>
      <NetworkItem {...storyNetwork} />
    </GroupFrame>
  ),
  play: async ({ userEvent, step }) => {
    await expectPhone(step);
    const aside = (): HTMLElement => within(moreRow('network')).getByTestId('more-row-aside');
    await step('Given no chain in use, with More open', async () => {
      await openMore(userEvent);
      await expect(aside()).toHaveTextContent('Not in use');
      await expect(byId('more-button')).toHaveAttribute('aria-label', 'More');
    });
    await step('When a chain in use stalls', () => {
      setHealth('warn');
    });
    await step('Then the row says Unstable and More carries the warning badge in its name', async () => {
      await waitFor(() => expect(aside()).toHaveTextContent('Unstable'));
      await expect(byId('more-button')).toHaveAttribute('data-tone', 'warn');
      await expect(byId('more-button')).toHaveAttribute('aria-label', 'More, network unstable');
    });
  },
};
