// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { byId, query } from '@dotli/ui/testing';
import type { PermissionStatus } from '../../runtime/permissions.js';
import { expectPhone, openSurface } from '../../testing/stories/topbar-frame.js';
import { GroupFrame, moreRow, openMore } from '../../testing/stories/frames.js';
import {
  givenApp,
  resetStoryPermissions,
  STORY_PERMISSIONS,
  storyPermissions,
} from '../../testing/stories/permissions-fixtures.js';
import {
  DEFAULT_SETTINGS,
  givenSettings,
  resetStorySettings,
  storySettings,
} from '../../testing/stories/settings-fixtures.js';
import { resetStoryNetwork, storyNetwork } from '../../testing/stories/network-fixtures.js';
import { NetworkItem } from '../chains/NetworkItem.js';
import { PermissionsItem } from '../permissions/PermissionsItem.js';
import { SettingsItem } from '../settings/SettingsItem.js';

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

/** As a user, I press More and see the actions that do not fit in the bar. */
export const Open: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    await open(ctx);
  },
};

/** As a phone user, I press More and see a sheet of the actions that do not fit in the bar. */
export const OpenPhone: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ctx => {
    await expectPhone(ctx.step);
    await open(ctx);
  },
};

/**
 * As a user, I choose the Settings row in More and Settings opens in More's place, and Escape hands my focus back to
 * More.
 */
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

/**
 * As a phone user with the permissions button in More, I see its row carry the grants mark while the app has a grant,
 * and open the panel with every permission and its status.
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
 * As a mobile user who opened the settings from More, I get focus in the sheet and get it back on More when I close it
 * by Close or Escape.
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

/**
 * As a phone user with the settings button in More, I see its row carry the unverified mark while the session is
 * unverified.
 */
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
