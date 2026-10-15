// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { byId, byTestId } from '@dotli/ui/testing';
import type { PermissionStatus } from '../../runtime/permissions.js';
import { expectPhone, openSurface, TopbarFrame } from '../../testing/stories/topbar-frame.js';
import {
  givenApp,
  givenNotice,
  permissionsAsked,
  readAll,
  resetStoryPermissions,
  STORY_PERMISSIONS,
  storyPermissions,
} from '../../testing/stories/permissions-fixtures.js';
import { PermissionsItem } from './PermissionsItem.js';

const open = openSurface({ trigger: 'permissions-button', surface: 'permissions-popover' });

const STATUSES: readonly PermissionStatus[] = ['ask', 'granted', 'denied'];

function row(name: string): HTMLElement {
  const found = byId(`permissions-popover-name-${name}`).closest<HTMLElement>(
    '[data-testid="permissions-popover-row"]',
  );
  if (found === null) {
    throw new Error(`No ${name} row`);
  }
  return found;
}

const segment = (name: string, status: PermissionStatus): HTMLElement =>
  within(row(name)).getByTestId(`permissions-popover-segment-${status}`);

const statusOf = (name: string): PermissionStatus | undefined =>
  STATUSES.find(status => segment(name, status).getAttribute('aria-pressed') === 'true');

const reset = (): HTMLButtonElement => byTestId('permissions-popover-reset', document, HTMLButtonElement);

const hint = (): string | null | undefined =>
  document.querySelector('#permissions-popover-list [data-testid="permissions-popover-hint"]')?.textContent;

/** Each group's heading and its permissions, in menu order. */
const GROUPS = [
  {
    label: 'Device',
    names: ['Notifications', 'Camera', 'Microphone', 'Location', 'Bluetooth', 'NFC', 'Clipboard', 'Biometrics'],
  },
  { label: 'Account and chain', names: ['IdentityDisclosure', 'ChainSubmit', 'PreimageSubmit', 'StatementSubmit'] },
];

/** The permissions button and panel as the host composes them, given the story's permissions. */
function StoryPermissions(): JSX.Element {
  return <PermissionsItem {...storyPermissions} />;
}

const meta = {
  title: 'Host/Permissions',
  component: StoryPermissions,
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  beforeEach: () => {
    resetStoryPermissions();
  },
  render: () => (
    <TopbarFrame>
      <StoryPermissions />
    </TopbarFrame>
  ),
} satisfies Meta<typeof StoryPermissions>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * As a user of a loaded app, the popover lists its device and app permissions in named groups, each with its status
 * pressed, and the open dialog is named Permissions.
 */
export const Open: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp({ Camera: 'granted', ChainSubmit: 'denied' });
  },
  play: async ctx => {
    const button = byId('permissions-button');
    await ctx.step('Given the app has grants', async () => {
      await waitFor(() => expect(button).toHaveAttribute('data-badge'));
    });
    await open(ctx);
    await ctx.step('Then it is the open dialog named Permissions', async () => {
      await expect(button).toHaveAttribute('aria-expanded', 'true');
      const popover = byId('permissions-popover');
      await expect(popover).toHaveAttribute('role', 'dialog');
      await expect(popover).toHaveAttribute('aria-label', 'Permissions');
      await expect(within(popover).getByTestId('permissions-popover-header').querySelector('h2')).toHaveTextContent(
        'Permissions',
      );
      await expect(within(popover).getByTestId('permissions-popover-foot')).toHaveTextContent('Changes reload the app');
    });
    await ctx.step('And every permission is in its named group, with Ask, Allow and Deny', async () => {
      const groups = [...document.querySelectorAll<HTMLElement>('[data-testid="permissions-popover-group"]')];
      await expect(groups.map(group => group.querySelector('h3')?.textContent)).toEqual(GROUPS.map(g => g.label));
      for (const [i, group] of groups.entries()) {
        await expect(group).toHaveAttribute('role', 'group');
        await expect(byId(group.getAttribute('aria-labelledby') ?? '').textContent).toBe(GROUPS[i]?.label);
        const names = [
          ...group.querySelectorAll('[data-testid="permissions-popover-row"] [id^="permissions-popover-name-"]'),
        ].map(name => name.id.replace('permissions-popover-name-', ''));
        await expect(names).toEqual(GROUPS[i]?.names);
      }
      const camera = row('Camera');
      const label = STORY_PERMISSIONS.find(perm => perm.name === 'Camera')?.label;
      await expect(within(camera).getByRole('group')).toHaveAttribute('aria-label', label);
      await expect(
        within(camera)
          .getAllByRole('button')
          .map(b => b.textContent),
      ).toEqual(['Ask', 'Allow', 'Deny']);
    });
    await ctx.step('And each status is pressed as the page read it, with focus on the first control', async () => {
      await expect(statusOf('Camera')).toBe('granted');
      await expect(statusOf('ChainSubmit')).toBe('denied');
      await expect(statusOf('Notifications')).toBe('ask');
      await expect(segment('Camera', 'ask')).toHaveAttribute('aria-pressed', 'false');
      await waitFor(() => expect(row('Notifications').contains(document.activeElement)).toBe(true));
    });
  },
};

/** As a phone user, the permissions sheet leaves out its own heading and lists every permission. */
export const OpenPhone: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  beforeEach: () => {
    givenApp();
  },
  play: async ctx => {
    await expectPhone(ctx.step);
    await open(ctx);
    await ctx.step('Then the sheet is titled Permissions, with no heading of its own', async () => {
      const sheet = byId('permissions-popover');
      await expect(within(sheet).getByTestId('popover-sheet-title')).toHaveTextContent('Permissions');
      await expect(sheet.querySelector('[data-testid="permissions-popover-header"]')).toBeNull();
      await expect(sheet.querySelectorAll('[data-testid="permissions-popover-row"]')).toHaveLength(
        STORY_PERMISSIONS.length,
      );
    });
  },
};

/** As a user with no app loaded yet, or none on this domain, the popover says so. */
export const NoApp: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    await open(ctx);
    await ctx.step('Then it says to wait for the app', async () => {
      await waitFor(() => expect(hint()).toBe('Wait for the app to finish loading to change its permissions.'));
      await expect(document.querySelector('[data-testid="permissions-popover-foot"]')).toBeNull();
    });
    await ctx.step('When the load fails', () => {
      givenNotice('no-app');
    });
    await ctx.step('Then it says no app is loaded here', async () => {
      await waitFor(() => expect(hint()).toBe('No app is loaded on this domain.'));
    });
  },
};

/** As a user whose app's permissions cannot be read, the popover says they are unavailable. */
export const Unavailable: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenNotice('unavailable');
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Then it says they are unavailable, and the button has no badge', async () => {
      await waitFor(() => expect(hint()).toBe('Permissions are unavailable for this app.'));
      await expect(byId('permissions-button')).not.toHaveAttribute('data-badge');
    });
  },
};

/** As a user, pressing a status asks the page for it, and the popover stays open on the status the page applied. */
export const AllowChooses: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp({ Camera: 'granted' });
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('When I allow Notifications', async () => {
      await ctx.userEvent.click(segment('Notifications', 'granted'));
    });
    await ctx.step('Then it was asked for and is shown, and the popover stays open', async () => {
      await waitFor(() => expect(statusOf('Notifications')).toBe('granted'));
      await expect(permissionsAsked.choices).toHaveBeenCalledTimes(1);
      await expect(permissionsAsked.choices).toHaveBeenCalledWith('Notifications', 'granted');
      await expect(byId('permissions-popover')).toHaveAttribute('data-open');
    });
    await ctx.step('When I set Camera back to Ask', async () => {
      await ctx.userEvent.click(segment('Camera', 'ask'));
    });
    await ctx.step('Then that was asked for and is shown', async () => {
      await waitFor(() => expect(statusOf('Camera')).toBe('ask'));
      await expect(permissionsAsked.choices).toHaveBeenLastCalledWith('Camera', 'ask');
    });
  },
};

/** As a keyboard user, choosing a status keeps my focus on the segment I pressed. */
export const KeyboardKeepsFocus: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp();
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('When I press Allow on Camera from the keyboard', async () => {
      segment('Camera', 'granted').focus();
      await ctx.userEvent.keyboard('{Enter}');
    });
    await ctx.step('Then Camera is allowed and focus stayed on Allow', async () => {
      await waitFor(() => expect(statusOf('Camera')).toBe('granted'));
      await expect(segment('Camera', 'granted')).toHaveFocus();
    });
  },
};

/** As a user, the lock button shows its grants badge while the app has any permission granted. */
export const GrantsBadge: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp({ ChainSubmit: 'granted' });
  },
  play: async ({ step }) => {
    const button = byId('permissions-button');
    await step("Then the badge shows for the app's grant", async () => {
      await waitFor(() => expect(button).toHaveAttribute('data-badge'));
    });
    await step('When the only grant goes back to Ask', () => {
      storyPermissions.onChoose('ChainSubmit', 'ask');
    });
    await step('Then the badge goes', async () => {
      await waitFor(() => expect(button).not.toHaveAttribute('data-badge'));
    });
    await step('When Camera is allowed', () => {
      storyPermissions.onChoose('Camera', 'granted');
    });
    await step('Then the badge is back', async () => {
      await waitFor(() => expect(button).toHaveAttribute('data-badge'));
    });
    await step('When the app fails to load', () => {
      givenNotice('no-app');
    });
    await step('Then the badge goes', async () => {
      await waitFor(() => expect(button).not.toHaveAttribute('data-badge'));
    });
  },
};

/** As a user opening the popover again, the page is asked to read the statuses again, and the newer read shows. */
export const ReopenReadsAgain: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp();
    readAll('granted');
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('And closed again', async () => {
      await waitFor(() => expect(permissionsAsked.opens).toBe(1));
      await waitFor(() => expect(statusOf('Camera')).toBe('granted'));
      await ctx.userEvent.keyboard('{Escape}');
      await waitFor(() => expect(byId('permissions-popover')).not.toHaveAttribute('data-open'));
    });
    await ctx.step('When I open it again', async () => {
      await ctx.userEvent.click(byId('permissions-button'));
      await waitFor(() => expect(byId('permissions-popover')).toHaveAttribute('data-open'));
    });
    await ctx.step('Then one new read is asked for while the last answer shows', async () => {
      await waitFor(() => expect(permissionsAsked.opens).toBe(2));
      await expect(statusOf('Camera')).toBe('granted');
    });
    await ctx.step('When it answers', () => {
      readAll('denied');
    });
    await ctx.step('Then its answer shows', async () => {
      await waitFor(() => expect(statusOf('Camera')).toBe('denied'));
    });
  },
};

/** As a user with nothing granted or denied, Reset all to Ask is disabled and asks for nothing. */
export const ResetDisabledWhenNothing: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp();
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Then Reset all to Ask is disabled', async () => {
      await expect(reset()).toHaveTextContent('Reset all to Ask');
      await waitFor(() => expect(reset()).toBeDisabled());
    });
    await ctx.step('When I try it anyway', () => {
      reset().click();
    });
    await ctx.step('Then nothing was asked for', async () => {
      await expect(permissionsAsked.resets).toBe(0);
      await expect(permissionsAsked.choices).not.toHaveBeenCalled();
    });
  },
};

/** As a keyboard user, Reset all to Ask leaves my focus in the popover once the button has nothing left to reset. */
export const ResetKeepsFocus: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp({ Camera: 'granted' });
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('When I press Reset all to Ask from the keyboard', async () => {
      await waitFor(() => expect(reset()).not.toBeDisabled());
      reset().focus();
      await ctx.userEvent.keyboard('{Enter}');
    });
    await ctx.step(
      'Then the reset was asked for once, the button is disabled and focus is on the open popover',
      async () => {
        await waitFor(() => expect(reset()).toBeDisabled());
        await expect(permissionsAsked.resets).toBe(1);
        await expect(byId('permissions-popover')).toHaveAttribute('data-open');
        await expect(byId('permissions-popover')).toHaveFocus();
        await expect(statusOf('Camera')).toBe('ask');
      },
    );
  },
};
