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
  holdChanges,
  changesSettled,
  permissionsAsked,
  readAll,
  refuseChanges,
  resetStoryPermissions,
  STORY_PERMISSIONS,
  storyPermissions,
} from '../../testing/stories/permissions-fixtures.js';
import { PermissionsItem } from './PermissionsItem.js';
import { SECURE, TRUSTED, UNLIMITED } from './presets.js';

type UserEvent = Parameters<NonNullable<Story['play']>>[0]['userEvent'];

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

const presets = (): HTMLElement => byTestId('permissions-presets', document, HTMLElement);

const slider = (): HTMLElement => within(presets()).getByRole('slider');

const stop = (id: string): HTMLElement => byTestId(`permissions-preset-stop-${id}`, document, HTMLElement);

const errorLine = (): Element | null => document.querySelector('[data-testid="permissions-popover-error"]');

const advanced = (): HTMLDetailsElement => byTestId('permissions-advanced', document, HTMLDetailsElement);

async function openAdvanced(userEvent: UserEvent): Promise<void> {
  if (!advanced().open) {
    await userEvent.click(byTestId('permissions-advanced-toggle', document, HTMLElement));
  }
  await waitFor(() => expect(advanced().open).toBe(true));
}

async function expectPreset(id: string, modified: boolean): Promise<void> {
  await waitFor(() => expect(presets()).toHaveAttribute('data-preset', id));
  if (modified) {
    await expect(presets()).toHaveAttribute('data-modified');
    await expect(byTestId('permissions-preset-modified', document, HTMLElement)).toHaveTextContent('Modified');
  } else {
    await expect(presets()).not.toHaveAttribute('data-modified');
  }
}

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
 * As a user of a loaded app, the popover shows the closest preset on a slider with its line, focus on the slider, and
 * every permission in named groups under a closed Advanced.
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
    await ctx.step('And the slider shows Secure, modified, with its line and value text, and holds focus', async () => {
      await expectPreset('secure', true);
      await expect(byTestId('permissions-preset-name', document, HTMLElement)).toHaveTextContent('Secure');
      await expect(byTestId('permissions-preset-line', document, HTMLElement)).toHaveTextContent(
        'Decide each time the app asks.',
      );
      await expect(slider()).toHaveAttribute('aria-valuetext', 'Secure, modified');
      await waitFor(() => expect(slider()).toHaveFocus());
      await expect(advanced().open).toBe(false);
    });
    await ctx.step('When I open Advanced', async () => {
      await openAdvanced(ctx.userEvent);
    });
    await ctx.step(
      'Then every permission is in its named group, with Ask, Allow and Deny and its status pressed',
      async () => {
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
        await expect(within(camera).getByRole('group')).toHaveAttribute('aria-label', 'Camera');
        await expect(
          within(camera)
            .getAllByRole('button')
            .map(b => b.textContent),
        ).toEqual(['Ask', 'Allow', 'Deny']);
        await expect(statusOf('Camera')).toBe('granted');
        await expect(statusOf('ChainSubmit')).toBe('denied');
        await expect(statusOf('Notifications')).toBe('ask');
      },
    );
  },
};

/** As a phone user, the permissions sheet leaves out its own heading and lists every permission under Advanced. */
export const OpenPhone: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  beforeEach: () => {
    givenApp();
  },
  play: async ctx => {
    await expectPhone(ctx.step);
    await open(ctx);
    await ctx.step('When I open Advanced', async () => {
      await openAdvanced(ctx.userEvent);
    });
    await ctx.step('Then the sheet is titled Permissions, with no heading of its own, and every row', async () => {
      const sheet = byId('permissions-popover');
      await expect(within(sheet).getByTestId('popover-sheet-title')).toHaveTextContent('Permissions');
      await expect(sheet.querySelector('[data-testid="permissions-popover-header"]')).toBeNull();
      await expect(sheet.querySelectorAll('[data-testid="permissions-popover-row"]')).toHaveLength(
        STORY_PERMISSIONS.length,
      );
    });
  },
};

/** As a user with no app loaded yet, or none on this domain, the popover says so and shows no slider. */
export const NoApp: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    await open(ctx);
    await ctx.step('Then it says to wait for the app', async () => {
      await waitFor(() => expect(hint()).toBe('Wait for the app to finish loading to change its permissions.'));
      await expect(document.querySelector('[data-testid="permissions-popover-foot"]')).toBeNull();
      await expect(document.querySelector('[data-testid="permissions-presets"]')).toBeNull();
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

/** As a user, pressing Trusted asks for all twelve of its statuses and the slider shows Trusted with its line. */
export const PresetMove: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp();
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Given the slider shows Secure, not modified', async () => {
      await expectPreset('secure', false);
    });
    await ctx.step('When I press Trusted', async () => {
      await ctx.userEvent.click(stop('trusted'));
    });
    await ctx.step('Then all twelve Trusted statuses were asked for and Trusted shows', async () => {
      await expect(permissionsAsked.changes).toHaveBeenCalledTimes(1);
      await expect(permissionsAsked.changes).toHaveBeenCalledWith(TRUSTED.statuses);
      await expectPreset('trusted', false);
      await expect(byTestId('permissions-preset-line', document, HTMLElement)).toHaveTextContent(
        'For apps you use often.',
      );
    });
  },
};

/** As a keyboard user, each arrow step on the slider asks for its preset. */
export const KeyboardSteps: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp();
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('When I press ArrowRight twice on the slider', async () => {
      slider().focus();
      await ctx.userEvent.keyboard('{ArrowRight}');
      await expectPreset('trusted', false);
      await ctx.userEvent.keyboard('{ArrowRight}');
    });
    await ctx.step('Then Trusted and then Unlimited were asked for', async () => {
      await expect(permissionsAsked.changes).toHaveBeenNthCalledWith(1, TRUSTED.statuses);
      await expect(permissionsAsked.changes).toHaveBeenNthCalledWith(2, UNLIMITED.statuses);
      await expectPreset('unlimited', false);
    });
  },
};

/** As a user, a row I change in Advanced is asked for alone, and the slider marks its preset modified. */
export const RowMarksModified: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp();
  },
  play: async ctx => {
    await open(ctx);
    await openAdvanced(ctx.userEvent);
    await ctx.step('When I allow Location', async () => {
      await ctx.userEvent.click(segment('Location', 'granted'));
    });
    await ctx.step('Then only Location was asked for and Secure shows modified', async () => {
      await expect(permissionsAsked.changes).toHaveBeenCalledTimes(1);
      await expect(permissionsAsked.changes).toHaveBeenCalledWith({ Location: 'granted' });
      await waitFor(() => expect(statusOf('Location')).toBe('granted'));
      await expectPreset('secure', true);
      await expect(slider()).toHaveAttribute('data-marked');
    });
  },
};

/** As a user on a modified preset, pressing that preset again asks for all of it and clears the mark. */
export const RepressModifiedReapplies: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp({ Camera: 'granted' });
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Given Secure shows modified', async () => {
      await expectPreset('secure', true);
    });
    await ctx.step('When I press Secure', async () => {
      await ctx.userEvent.click(stop('secure'));
    });
    await ctx.step('Then all of Secure was asked for and the mark is gone', async () => {
      await expect(permissionsAsked.changes).toHaveBeenCalledTimes(1);
      await expect(permissionsAsked.changes).toHaveBeenCalledWith(SECURE.statuses);
      await expectPreset('secure', false);
    });
  },
};

/**
 * As a keyboard user, a row I press while a change is pending is ignored, keeps my focus, and the popover stays open,
 * while a preset I press is still asked for.
 */
export const PendingLocksRows: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp();
  },
  play: async ctx => {
    await open(ctx);
    await openAdvanced(ctx.userEvent);
    const release = holdChanges();
    await ctx.step('When I allow Notifications from the keyboard and the change stays pending', async () => {
      segment('Notifications', 'granted').focus();
      await ctx.userEvent.keyboard('{Enter}');
      await waitFor(() => expect(byId('permissions-popover-list')).toHaveAttribute('data-pending'));
    });
    await ctx.step('Then the rows wait, focus stays on Allow, and the slider still takes a move', async () => {
      await expect(byTestId('permissions-preset-pending', document, HTMLElement)).toBeInTheDocument();
      await expect(within(row('Camera')).getByRole('group')).toHaveAttribute('aria-disabled', 'true');
      await expect(segment('Notifications', 'granted')).toHaveFocus();
      await expect(byId('permissions-popover')).toHaveAttribute('data-open');
      await expect(slider()).not.toHaveAttribute('aria-disabled');
    });
    await ctx.step('When I press Deny on Camera anyway', async () => {
      await ctx.userEvent.click(segment('Camera', 'denied'));
    });
    await ctx.step('Then nothing more was asked for', async () => {
      await expect(permissionsAsked.changes).toHaveBeenCalledTimes(1);
    });
    await ctx.step('When I press Trusted on the slider', async () => {
      await ctx.userEvent.click(stop('trusted'));
    });
    await ctx.step('Then all of Trusted was asked for', async () => {
      await expect(permissionsAsked.changes).toHaveBeenCalledTimes(2);
      await expect(permissionsAsked.changes).toHaveBeenNthCalledWith(2, TRUSTED.statuses);
    });
    await ctx.step('When the changes settle', () => {
      release();
    });
    await ctx.step('Then the rows take presses again', async () => {
      await waitFor(() => expect(byId('permissions-popover-list')).not.toHaveAttribute('data-pending'));
      await expect(within(row('Camera')).getByRole('group')).not.toHaveAttribute('aria-disabled');
      await waitFor(() => expect(document.querySelector('[data-testid="permissions-preset-pending"]')).toBeNull());
    });
  },
};

/**
 * As a user whose move the core refuses for Camera, the panel names Camera, and a failure of a move made before I
 * closed and reopened the panel never shows.
 */
export const FailedChangeNamesPermissions: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp();
    refuseChanges(['Camera']);
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('When I press Trusted', async () => {
      await ctx.userEvent.click(stop('trusted'));
    });
    await ctx.step('Then the panel names Camera and shows Trusted modified', async () => {
      await waitFor(() => expect(errorLine()).toHaveTextContent("Couldn't change Camera."));
      await expectPreset('trusted', true);
    });
    const release = holdChanges();
    await ctx.step('When I press Unlimited and close the panel while it is pending', async () => {
      await ctx.userEvent.click(stop('unlimited'));
      await waitFor(() => expect(errorLine()).toBeNull());
      await ctx.userEvent.keyboard('{Escape}');
      await waitFor(() => expect(byId('permissions-popover')).not.toHaveAttribute('data-open'));
    });
    await ctx.step('And I open the panel again before the move fails', async () => {
      await ctx.userEvent.click(byId('permissions-button'));
      await waitFor(() => expect(byId('permissions-popover')).toHaveAttribute('data-open'));
      release();
    });
    await ctx.step('Then the move settles with Camera kept, and no error shows', async () => {
      await expectPreset('unlimited', true);
      await waitFor(() => expect(byId('permissions-popover-list')).not.toHaveAttribute('data-pending'));
      await changesSettled();
      await expect(errorLine()).toBeNull();
    });
  },
};

/** As a user who makes a newer move before an older one fails, only the newer move's outcome shows. */
export const OlderFailureNeverShows: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp();
    refuseChanges(['Camera']);
  },
  play: async ctx => {
    await open(ctx);
    const releaseOlder = holdChanges();
    await ctx.step('Given I press Unlimited, which the core will refuse for Camera, and it stays pending', async () => {
      await ctx.userEvent.click(stop('unlimited'));
      await waitFor(() => expect(byId('permissions-popover-list')).toHaveAttribute('data-pending'));
    });
    refuseChanges([]);
    const releaseNewer = holdChanges();
    await ctx.step('When I press Secure, which lands, and then Unlimited fails', async () => {
      await ctx.userEvent.click(stop('secure'));
      await expect(permissionsAsked.changes).toHaveBeenCalledTimes(2);
      releaseNewer();
      releaseOlder();
    });
    await ctx.step('Then no error shows', async () => {
      await changesSettled();
      await expectPreset('secure', false);
      await expect(errorLine()).toBeNull();
    });
  },
};

/** As a user, Advanced starts closed every time I open the panel. */
export const AdvancedStartsClosed: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp();
  },
  play: async ctx => {
    await open(ctx);
    await openAdvanced(ctx.userEvent);
    await ctx.step('When I close the panel and open it again', async () => {
      await ctx.userEvent.keyboard('{Escape}');
      await waitFor(() => expect(byId('permissions-popover')).not.toHaveAttribute('data-open'));
      await ctx.userEvent.click(byId('permissions-button'));
      await waitFor(() => expect(byId('permissions-popover')).toHaveAttribute('data-open'));
    });
    await ctx.step('Then Advanced is closed', async () => {
      await expect(advanced().open).toBe(false);
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
    await openAdvanced(ctx.userEvent);
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
    await step('When the only grant goes back to Ask', async () => {
      await storyPermissions.onChange({ ChainSubmit: 'ask' });
    });
    await step('Then the badge goes', async () => {
      await waitFor(() => expect(button).not.toHaveAttribute('data-badge'));
    });
    await step('When Camera is allowed', async () => {
      await storyPermissions.onChange({ Camera: 'granted' });
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
      await expectPreset('unlimited', false);
      await ctx.userEvent.keyboard('{Escape}');
      await waitFor(() => expect(byId('permissions-popover')).not.toHaveAttribute('data-open'));
    });
    await ctx.step('When I open it again', async () => {
      await ctx.userEvent.click(byId('permissions-button'));
      await waitFor(() => expect(byId('permissions-popover')).toHaveAttribute('data-open'));
    });
    await ctx.step('Then one new read is asked for while the last answer shows', async () => {
      await waitFor(() => expect(permissionsAsked.opens).toBe(2));
      await expectPreset('unlimited', false);
    });
    await ctx.step('When it answers', () => {
      readAll('denied');
    });
    await ctx.step('Then its answer shows', async () => {
      await expectPreset('restricted', false);
    });
  },
};

/** As a user on Secure, Reset to Secure is disabled and asks for nothing. */
export const ResetDisabledAtSecure: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp();
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Then Reset to Secure is disabled', async () => {
      await expect(reset()).toHaveTextContent('Reset to Secure');
      await waitFor(() => expect(reset()).toBeDisabled());
    });
    await ctx.step('When I try it anyway', () => {
      reset().click();
    });
    await ctx.step('Then nothing was asked for', async () => {
      await expect(permissionsAsked.changes).not.toHaveBeenCalled();
    });
  },
};

/** As a keyboard user, Reset to Secure asks for all of Secure and leaves my focus in the open popover. */
export const ResetKeepsFocus: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp({ Camera: 'granted' });
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('When I press Reset to Secure from the keyboard', async () => {
      await waitFor(() => expect(reset()).not.toBeDisabled());
      reset().focus();
      await ctx.userEvent.keyboard('{Enter}');
    });
    await ctx.step(
      'Then all of Secure was asked for, the button is disabled and focus is on the open popover',
      async () => {
        await waitFor(() => expect(reset()).toBeDisabled());
        await expect(permissionsAsked.changes).toHaveBeenCalledTimes(1);
        await expect(permissionsAsked.changes).toHaveBeenCalledWith(SECURE.statuses);
        await expect(byId('permissions-popover')).toHaveAttribute('data-open');
        await expect(byId('permissions-popover')).toHaveFocus();
        await expectPreset('secure', false);
      },
    );
  },
};
