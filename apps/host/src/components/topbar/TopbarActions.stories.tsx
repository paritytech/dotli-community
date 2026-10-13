// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { expectPhone, reachable, TopbarFrame } from '../../../.storybook/topbar-frame.js';
import {
  disconnect,
  resetStoryAccount,
  storyAccount,
  storyCallbacks,
  storyModalOpen,
} from '../../../.storybook/account-fixtures.js';
import { moreRow, moreRowNames, openMore } from '../../../.storybook/frames.js';
import { givenApp, resetStoryPermissions, storyPermissions } from '../../../.storybook/permissions-fixtures.js';
import {
  DEFAULT_SETTINGS,
  givenSettings,
  resetStorySettings,
  storySettings,
} from '../../../.storybook/settings-fixtures.js';
import { resetStoryNetwork, setHealth, storyNetwork } from '../../../.storybook/network-fixtures.js';
import type { TopbarMorph } from '../../topbar-status.js';
import { AccountItem, NetworkItem, PermissionsItem, SettingsItem } from './items.js';
import { TopbarActions } from './TopbarActions.js';

/** A phone bar with room for the account and More only, so every other item is a More row. */
const MORE_ONLY = 80;

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`No #${id}`);
  }
  return found;
}

const opened = (id: string): Promise<void> => waitFor(() => expect(el(id)).toHaveAttribute('data-open'));
const closed = (id: string): Promise<void> => waitFor(() => expect(el(id)).not.toHaveAttribute('data-open'));

const phone = { viewport: { value: 'phone', isRotated: false } };

/** An app with a grant, as the page reads its permissions. */
function givenGrant(): void {
  givenApp({ Camera: 'granted' });
}

/** A session the light client does not verify, as the page reads its settings. */
function givenUnverified(): void {
  givenSettings({ ...DEFAULT_SETTINGS, backend: 'rpc-gateway', verified: false });
}

/** A bar that never morphs. */
const STILL: TopbarMorph = { running: () => false, onEnd: () => () => undefined };

/** The actions as the host's island renders them, with the story's network, permissions, settings and account. */
function Actions(): JSX.Element {
  return (
    <TopbarActions
      // The group measures its own width, as the phone bar's room is.
      room={() => undefined}
      morph={STILL}
      network={<NetworkItem {...storyNetwork} />}
      permissions={<PermissionsItem {...storyPermissions} />}
      settings={<SettingsItem {...storySettings} />}
      account={
        <AccountItem
          account={storyAccount}
          modalOpen={storyModalOpen}
          onSignIn={storyCallbacks.onSignIn}
          onLogout={storyCallbacks.onLogout}
          handOver={storyCallbacks.handOver}
        />
      }
    />
  );
}

const meta = {
  title: 'Host/Topbar/TopbarActions',
  component: Actions,
  parameters: { chrome: true, docs: { story: { inline: false, height: '560px' } } },
  tags: ['!autodocs'],
  globals: phone,
  beforeEach: () => {
    resetStoryNetwork();
    resetStoryPermissions();
    resetStorySettings();
    resetStoryAccount();
    disconnect();
  },
  render: () => (
    <TopbarFrame>
      <Actions />
    </TopbarFrame>
  ),
} satisfies Meta<typeof Actions>;

export default meta;
type Story = StoryObj<typeof meta>;

const narrow = () => (
  <TopbarFrame maxWidth={MORE_ONLY}>
    <Actions />
  </TopbarFrame>
);

/** As a mobile user, the lock button marks the app's grants, and the More menu's Permissions row opens its popover. */
export const PermissionsRowShowsGrants: Story = {
  beforeEach: () => {
    givenGrant();
  },
  render: narrow,
  play: async ({ userEvent, step }) => {
    await expectPhone(step);
    await step('Given the lock button carries the grant badge', async () => {
      await waitFor(() => expect(el('permissions-button')).toHaveAttribute('data-badge'));
    });
    await step('When I choose Permissions in More', async () => {
      await openMore(userEvent);
      await userEvent.click(moreRow('permissions'));
    });
    await step('Then More closed and Permissions is open with focus', async () => {
      await opened('permissions-popover');
      await expect(el('more-popover')).not.toHaveAttribute('data-open');
      await waitFor(() => expect(el('permissions-popover').contains(document.activeElement)).toBe(true));
    });
  },
};

/** As a mobile user, the More menu's Network and Settings rows open the network panel and the settings popover. */
export const NetworkAndSettingsRowsOpen: Story = {
  render: narrow,
  play: async ({ userEvent, step }) => {
    await expectPhone(step);
    await step('When I choose Network in More', async () => {
      await openMore(userEvent);
      await expect(moreRowNames()[0]).toBe('network');
      await expect(within(moreRow('network')).getByTestId('more-row-aside')).toHaveTextContent('Not in use');
      await userEvent.click(moreRow('network'));
    });
    await step('Then the network panel is open in place of More, and the network button says so', async () => {
      await opened('chains-popover');
      await expect(el('more-popover')).not.toHaveAttribute('data-open');
      await expect(el('more-button')).toHaveAttribute('aria-expanded', 'false');
      await expect(el('chains-button')).toHaveAttribute('aria-expanded', 'true');
    });
    await step('When I press Escape', async () => {
      await userEvent.keyboard('{Escape}');
    });
    await step('Then both are closed', async () => {
      await closed('chains-popover');
      await expect(el('more-popover')).not.toHaveAttribute('data-open');
    });
    await step('When I choose Settings in More', async () => {
      await openMore(userEvent);
      await userEvent.click(moreRow('settings'));
    });
    await step('Then only Settings is open', async () => {
      await opened('mode-popover');
      await expect(el('chains-popover')).not.toHaveAttribute('data-open');
      await expect(el('more-popover')).not.toHaveAttribute('data-open');
    });
  },
};

/** As a mounted group, it is marked data-collapsible, so the CSS for its build-time render no longer applies. */
export const CollapsibleOnMount: Story = {
  play: async ({ step }) => {
    await step('Then the mounted group is marked collapsible', async () => {
      await waitFor(() => expect(el('topbar-actions')).toHaveAttribute('data-collapsible'));
    });
  },
};

/** As a phone user, the actions sit in the bar in place of the address while they fit, and the account ends it. */
export const PhoneActionsReplaceAddress: Story = {
  play: async ({ step }) => {
    await expectPhone(step);
    await step('Then every item is in the bar, More is parked, and the account comes after it', async () => {
      const more = document.querySelector('[data-testid="more-item"]');
      await waitFor(() => expect(more).toHaveAttribute('data-parked'));
      const items = [...document.querySelectorAll('#topbar-actions [data-testid="action-item"]')];
      await expect(items.filter(item => item.hasAttribute('data-parked'))).toEqual([]);
      const account = el('auth-button').closest('[data-testid="action-item"]');
      await expect(account).not.toBeNull();
      await expect(el('more-button').compareDocumentPosition(account as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
  },
};

/** As a phone user, the Network row leads the More menu with its verdict, and a stalled chain raises More's badge and name. */
export const PhoneNetworkRowLeads: Story = {
  render: narrow,
  play: async ({ userEvent, step }) => {
    await expectPhone(step);
    const more = el('more-button');
    await step('Given no chain in use', async () => {
      await openMore(userEvent);
      await expect(moreRowNames()[0]).toBe('network');
      await expect(within(moreRow('network')).getByTestId('more-row-aside')).toHaveTextContent('Not in use');
      await expect(more).toHaveAttribute('aria-label', 'More');
    });
    await step('When a chain in use stalls', () => {
      setHealth('warn');
    });
    await step('Then the row says Unstable and More carries the warning badge in its name', async () => {
      await waitFor(() =>
        expect(within(moreRow('network')).getByTestId('more-row-aside')).toHaveTextContent('Unstable'),
      );
      await expect(more).toHaveAttribute('data-tone', 'warn');
      await expect(more).toHaveAttribute('aria-label', 'More, network unstable');
    });
  },
};

/** As a phone user with a grant and an unverified session, the Permissions and Settings rows keep their badges, and More raises none. */
export const PhoneRowBadges: Story = {
  render: narrow,
  beforeEach: () => {
    givenUnverified();
    givenGrant();
  },
  play: async ({ userEvent, step }) => {
    await expectPhone(step);
    await step('When I open More', async () => {
      await waitFor(() => expect(el('permissions-button')).toHaveAttribute('data-badge'));
      await openMore(userEvent);
    });
    await step('Then the Permissions and Settings rows carry their badges and More none', async () => {
      await expect(within(moreRow('permissions')).getByRole('img')).toHaveAttribute('aria-label', 'Has permissions');
      await expect(within(moreRow('settings')).getByRole('img')).toHaveAttribute('aria-label', 'Unverified session');
      await expect(el('more-button')).toHaveAttribute('aria-label', 'More');
    });
  },
};

/** As a phone user with no grants and a verified session, I see the Permissions and Settings rows without badges. */
export const PhoneRowsWithoutBadges: Story = {
  render: narrow,
  play: async ({ userEvent, step }) => {
    await expectPhone(step);
    await step('When I open More', async () => {
      await openMore(userEvent);
    });
    await step('Then neither row has a badge', async () => {
      await expect(moreRow('permissions').querySelector('[data-testid="more-row-aside"]')).toBeNull();
      await expect(moreRow('settings').querySelector('[data-testid="more-row-aside"]')).toBeNull();
    });
  },
};

/** As a phone keyboard user, Tab in the More sheet reaches its Close button, which closes it and hands focus back to More. */
export const PhoneTabReachesSheetClose: Story = {
  render: narrow,
  play: async ({ userEvent, step }) => {
    await expectPhone(step);
    const button = el('more-button');
    await step('Given the More sheet opened from the keyboard', async () => {
      await reachable(button);
      button.focus();
      await userEvent.keyboard('{Enter}');
      await opened('more-popover');
    });
    await step('When I press Tab', async () => {
      await userEvent.tab();
    });
    const close = (): HTMLElement => within(el('more-popover')).getByTestId('menu-sheet-close');
    await step("Then focus stays in the sheet, on its head's Close button", async () => {
      await waitFor(() => expect(close()).toHaveFocus());
    });
    await step('When I press Close', async () => {
      await userEvent.click(close());
    });
    await step('Then the sheet closed and More has focus', async () => {
      await closed('more-popover');
      await waitFor(() => expect(button).toHaveFocus());
    });
  },
};

/** As a phone user choosing Permissions in More, the permissions sheet takes More's place without sliding. */
export const PhonePermissionsTakesMorePlace: Story = {
  render: narrow,
  play: async ({ userEvent, step }) => {
    await expectPhone(step);
    await step('When I choose Permissions in More', async () => {
      await openMore(userEvent);
      await userEvent.click(moreRow('permissions'));
    });
    await step('Then More goes and Permissions comes at rest, both marked as a hand-off', async () => {
      await opened('permissions-popover');
      await expect(el('permissions-popover')).toHaveAttribute('data-handoff');
      await expect(el('more-popover')).not.toHaveAttribute('data-open');
      await expect(el('more-popover')).toHaveAttribute('data-handoff');
      await waitFor(() => expect(el('permissions-popover').contains(document.activeElement)).toBe(true));
    });
  },
};

/** As a phone user choosing Settings in More, the settings sheet takes More's place without sliding. */
export const PhoneSettingsTakesMorePlace: Story = {
  render: narrow,
  play: async ({ userEvent, step }) => {
    await expectPhone(step);
    await step('When I choose Settings in More', async () => {
      await openMore(userEvent);
      await userEvent.click(moreRow('settings'));
    });
    await step('Then the settings sheet took its place, both marked as a hand-off', async () => {
      await opened('mode-popover');
      await expect(el('mode-popover')).toHaveAttribute('data-handoff');
      await expect(el('more-popover')).toHaveAttribute('data-handoff');
    });
  },
};

/**
 * As a phone user with the Permissions sheet open, pressing Settings in the bar swaps the sheets without sliding, and
 * pressing it again closes its sheet.
 */
export const PhoneBarSettingsSwapsSheets: Story = {
  beforeEach: () => {
    return () => {
      document.querySelector('body > [data-over-sheets]')?.removeAttribute('data-over-sheets');
    };
  },
  play: async ({ canvasElement, userEvent, step }) => {
    await expectPhone(step);
    await step('Given the Permissions sheet open from the bar, which stays live over it', async () => {
      // On the host page the bar is the body's child that a sheet leaves live. Here the story root stands in.
      let root: HTMLElement = canvasElement;
      while (root.parentElement !== null && root.parentElement !== document.body) {
        root = root.parentElement;
      }
      root.setAttribute('data-over-sheets', '');
      await reachable(el('permissions-button'));
      await userEvent.click(el('permissions-button'));
      await opened('permissions-popover');
      await expect(el('mode-button').closest('[inert]')).toBeNull();
    });
    await step('When I press Settings in the bar', async () => {
      await userEvent.click(el('mode-button'));
    });
    await step('Then the settings sheet took its place with focus, both marked as a hand-off', async () => {
      await opened('mode-popover');
      await expect(el('mode-popover')).toHaveAttribute('data-handoff');
      await expect(el('permissions-popover')).not.toHaveAttribute('data-open');
      await expect(el('permissions-popover')).toHaveAttribute('data-handoff');
      await waitFor(() => expect(el('mode-popover').contains(document.activeElement)).toBe(true));
    });
    await step('When I press Settings again', async () => {
      await userEvent.click(el('mode-button'));
    });
    await step('Then its sheet closes', async () => {
      await closed('mode-popover');
    });
  },
};

/** As a phone user closing a sheet that took More's place, it slides out. */
export const PhoneClosingSlidesOut: Story = {
  render: narrow,
  play: async ({ userEvent, step }) => {
    await expectPhone(step);
    await step("Given the Permissions sheet took More's place", async () => {
      await openMore(userEvent);
      await userEvent.click(moreRow('permissions'));
      await opened('permissions-popover');
    });
    await step('When I press Escape', async () => {
      await userEvent.keyboard('{Escape}');
    });
    await step('Then it closes with no hand-off mark, so it slides', async () => {
      await closed('permissions-popover');
      await expect(el('permissions-popover')).not.toHaveAttribute('data-handoff');
    });
  },
};
