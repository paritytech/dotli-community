// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { byId, byTestId } from '@dotli/ui/testing';
import { ALL_PERMISSIONS, type PermissionStatus } from '../policy/permissionPolicy.js';
import { expectPhone, openSurface, TopbarFrame } from '../../../testing/stories/topbarFrame.js';
import {
  givenApp,
  givenBrowserBlocks,
  givenNotice,
  holdChanges,
  changesSettled,
  permissionsAsked,
  readAll,
  refuseChanges,
  resetStoryPermissions,
  storyPermissions,
} from '../../../testing/stories/permissionsFixtures.js';
import { PermissionsItem } from './PermissionsItem.js';
import { SECURE, TRUSTED } from './presets.js';

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

function segment(name: string, status: PermissionStatus): HTMLElement {
  return within(row(name)).getByTestId(`permissions-popover-segment-${status}`);
}

/** The pressed status of `name`'s row, whose browser-gated rows offer no Allow. */
function statusOf(name: string): PermissionStatus | undefined {
  return STATUSES.find(
    status =>
      within(row(name)).queryByTestId(`permissions-popover-segment-${status}`)?.getAttribute('aria-pressed') === 'true',
  );
}

function reset(): HTMLButtonElement {
  return byTestId('permissions-popover-reset', document, HTMLButtonElement);
}

/** The notice's title and detail, empty when none shows. */
function hint(): (string | null | undefined)[] {
  return ['title', 'detail'].map(
    part =>
      document.querySelector(`#permissions-popover-list [data-testid="permissions-popover-hint-${part}"]`)?.textContent,
  );
}

function presets(): HTMLElement {
  return byTestId('permissions-presets', document, HTMLElement);
}

function slider(): HTMLElement {
  return within(presets()).getByRole('slider');
}

function stop(id: string): HTMLElement {
  return byTestId(`permissions-preset-stop-${id}`, document, HTMLElement);
}

function presetWarning(): Element | null {
  return document.querySelector('[data-testid="permissions-preset-warn"]');
}

function errorLine(): Element | null {
  return document.querySelector('[data-testid="permissions-popover-error"]');
}

function advanced(): HTMLDetailsElement {
  return byTestId('permissions-advanced', document, HTMLDetailsElement);
}

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
 * As a user of a loaded app with grants, the popover shows the closest preset with focus on the slider and each
 * permission's status under a closed Advanced.
 */
export const Open: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp({ Notifications: 'granted', Camera: 'denied', ChainSubmit: 'denied' });
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Then the slider shows Secure, modified, and holds focus', async () => {
      await expectPreset('secure', true);
      await waitFor(() => expect(slider()).toHaveFocus());
      await expect(advanced().open).toBe(false);
    });
    await ctx.step('When I open Advanced', async () => {
      await openAdvanced(ctx.userEvent);
    });
    await ctx.step('Then each permission shows its status pressed', async () => {
      await expect(statusOf('Notifications')).toBe('granted');
      await expect(statusOf('Camera')).toBe('denied');
      await expect(statusOf('ChainSubmit')).toBe('denied');
      await expect(statusOf('Microphone')).toBe('ask');
    });
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
        ALL_PERMISSIONS.length,
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
      await waitFor(() =>
        expect(hint()).toEqual(['App still loading', 'Wait for it to finish loading to change its permissions.']),
      );
      await expect(document.querySelector('[data-testid="permissions-popover-foot"]')).toBeNull();
      await expect(document.querySelector('[data-testid="permissions-presets"]')).toBeNull();
    });
    await ctx.step('When the load fails', () => {
      givenNotice('no-app');
    });
    await ctx.step('Then it says no app is loaded here', async () => {
      await waitFor(() =>
        expect(hint()).toEqual(['No app loaded', 'Permissions show here once an app loads on this domain.']),
      );
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
    await ctx.step('Then it says they are unavailable', async () => {
      await waitFor(() =>
        expect(hint()).toEqual(['Permissions unavailable', "dot.li couldn't read this app's permissions."]),
      );
    });
  },
};

/** As a user, pressing Trusted asks for all twelve of its statuses and the slider shows Trusted with its warning. */
export const PresetMove: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp();
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('Given the slider shows Secure, not modified, with no warning', async () => {
      await expectPreset('secure', false);
      await expect(presetWarning()).toBeNull();
    });
    await ctx.step('When I press Trusted', async () => {
      await ctx.userEvent.click(stop('trusted'));
    });
    await ctx.step('Then all twelve Trusted statuses were asked for and Trusted shows with its warning', async () => {
      await expect(permissionsAsked.changes).toHaveBeenCalledTimes(1);
      await expect(permissionsAsked.changes).toHaveBeenCalledWith(TRUSTED.statuses);
      await expectPreset('trusted', false);
      await expect(presetWarning()).not.toBeNull();
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
    await ctx.step('When I press ArrowRight and then ArrowLeft on the slider', async () => {
      slider().focus();
      await ctx.userEvent.keyboard('{ArrowRight}');
      await expectPreset('trusted', false);
      await ctx.userEvent.keyboard('{ArrowLeft}');
    });
    await ctx.step('Then Trusted and then Secure were asked for', async () => {
      await expect(permissionsAsked.changes).toHaveBeenNthCalledWith(1, TRUSTED.statuses);
      await expect(permissionsAsked.changes).toHaveBeenNthCalledWith(2, SECURE.statuses);
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
    await ctx.step('When I block Location', async () => {
      await ctx.userEvent.click(segment('Location', 'denied'));
    });
    await ctx.step('Then only Location was asked for, Secure shows modified and only Location is marked', async () => {
      await expect(permissionsAsked.changes).toHaveBeenCalledTimes(1);
      await expect(permissionsAsked.changes).toHaveBeenCalledWith({ Location: 'denied' });
      await waitFor(() => expect(statusOf('Location')).toBe('denied'));
      await expectPreset('secure', true);
      await expect(slider()).toHaveAttribute('data-marked');
      await expect(within(row('Location')).getByTestId('permissions-popover-row-modified')).toHaveAccessibleName(
        'Differs from the Secure preset',
      );
      await expect(within(row('Camera')).queryByTestId('permissions-popover-row-modified')).toBeNull();
    });
  },
};

/** As a user on a modified preset, pressing that preset again asks for all of it and clears the mark. */
export const RepressModifiedReapplies: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp({ Notifications: 'granted' });
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
    await ctx.step('When I press Block on Camera anyway', async () => {
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
 * As a user whose move the core refuses for Sign transactions, the panel names it, and a failure of a move made before
 * I closed and reopened the panel never shows.
 */
export const FailedChangeNamesPermissions: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp();
    refuseChanges(['ChainSubmit']);
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('When I press Trusted', async () => {
      await ctx.userEvent.click(stop('trusted'));
    });
    await ctx.step('Then the panel names Sign transactions and shows Trusted modified', async () => {
      await waitFor(() => expect(errorLine()).toHaveTextContent("Couldn't change Sign transactions."));
      await expectPreset('trusted', true);
    });
    const release = holdChanges();
    await ctx.step('When I press Trusted again and close the panel while it is pending', async () => {
      await ctx.userEvent.click(stop('trusted'));
      await waitFor(() => expect(errorLine()).toBeNull());
      await ctx.userEvent.keyboard('{Escape}');
      await waitFor(() => expect(byId('permissions-popover')).not.toHaveAttribute('data-open'));
    });
    await ctx.step('And I open the panel again before the move fails', async () => {
      await ctx.userEvent.click(byId('permissions-button'));
      await waitFor(() => expect(byId('permissions-popover')).toHaveAttribute('data-open'));
      release();
    });
    await ctx.step('Then the move settles with Sign transactions kept, and no error shows', async () => {
      await expectPreset('trusted', true);
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
    refuseChanges(['ChainSubmit']);
  },
  play: async ctx => {
    await open(ctx);
    const releaseOlder = holdChanges();
    await ctx.step(
      'Given I press Trusted, which the core will refuse for Sign transactions, and it stays pending',
      async () => {
        await ctx.userEvent.click(stop('trusted'));
        await waitFor(() => expect(byId('permissions-popover-list')).toHaveAttribute('data-pending'));
      },
    );
    refuseChanges([]);
    const releaseNewer = holdChanges();
    await ctx.step('When I press Secure, which lands, and then Trusted fails', async () => {
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
    await ctx.step('When I press Allow on Notifications from the keyboard', async () => {
      segment('Notifications', 'granted').focus();
      await ctx.userEvent.keyboard('{Enter}');
    });
    await ctx.step('Then Notifications is allowed and focus stayed on Allow', async () => {
      await waitFor(() => expect(statusOf('Notifications')).toBe('granted'));
      await expect(segment('Notifications', 'granted')).toHaveFocus();
    });
  },
};

/** As a user opening the popover again, the page is asked to read the statuses again, and the newer read shows. */
export const ReopenReadsAgain: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp(TRUSTED.statuses);
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('And closed again', async () => {
      await waitFor(() => expect(permissionsAsked.opens).toBe(1));
      await expectPreset('trusted', false);
      await ctx.userEvent.keyboard('{Escape}');
      await waitFor(() => expect(byId('permissions-popover')).not.toHaveAttribute('data-open'));
    });
    await ctx.step('When I open it again', async () => {
      await ctx.userEvent.click(byId('permissions-button'));
      await waitFor(() => expect(byId('permissions-popover')).toHaveAttribute('data-open'));
    });
    await ctx.step('Then one new read is asked for while the last answer shows', async () => {
      await waitFor(() => expect(permissionsAsked.opens).toBe(2));
      await expectPreset('trusted', false);
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
    givenApp({ Notifications: 'granted' });
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

/**
 * As a user, a device the browser asks for itself says when my browser blocks it, and I can block it in dot.li too.
 */
export const BrowserGatedRows: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenApp();
    givenBrowserBlocks(['Camera']);
  },
  play: async ctx => {
    await open(ctx);
    await openAdvanced(ctx.userEvent);
    await ctx.step('Then Camera says the browser blocks it, while Microphone says nothing', async () => {
      await expect(within(row('Camera')).getByTestId('permissions-popover-row-browser-blocked')).toBeVisible();
      await expect(within(row('Microphone')).queryByTestId('permissions-popover-row-browser-blocked')).toBeNull();
    });
    await ctx.step('When I press Block on Camera', async () => {
      await ctx.userEvent.click(segment('Camera', 'denied'));
    });
    await ctx.step('Then the block is asked for and shows pressed', async () => {
      await expect(permissionsAsked.changes).toHaveBeenCalledWith({ Camera: 'denied' });
      await waitFor(() => expect(statusOf('Camera')).toBe('denied'));
    });
  },
};
