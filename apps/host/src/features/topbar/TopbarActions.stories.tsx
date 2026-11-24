// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { createJSXDecorator, type Meta, type StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { byId } from '@dotli/ui/testing';
import { expectPhone, reachable, TopbarFrame } from '../../testing/stories/topbarFrame.js';
import {
  disconnect,
  resetStoryAccount,
  storyAccount,
  storyCallbacks,
  storyModalOpen,
} from '../../testing/stories/accountFixtures.js';
import { moreRow, openMore } from '../../testing/stories/frames.js';
import { resetStoryPermissions, storyPermissions } from '../../testing/stories/permissionsFixtures.js';
import { resetStorySettings, storySettings } from '../../testing/stories/settingsFixtures.js';
import { resetStoryNetwork, setHealth, storyNetwork } from '../../testing/stories/networkFixtures.js';
import { chatStage } from '../../testing/stories/chatFixtures.js';
import type { ActionGroupMorph } from '@dotli/ui';
import { ChatItem } from '../chat/index.js';
import { NetworkItem } from '../network/index.js';
import { PermissionsItem } from '../permissions/index.js';
import { SettingsItem } from '../settings/index.js';
import { AccountItem } from '../account/index.js';
import { TopbarActions } from './TopbarActions.js';

/** Room in the bar for the account and More only, so every other item is a More row. */
const MORE_ONLY = 80;

/** A chat with no room yet, so the chat button stays hidden. */
const CHAT = chatStage({ available: false }).button;

/** A bar that never morphs. */
const STILL: ActionGroupMorph = { running: () => false, onEnd: () => () => undefined };

const PHONE = { viewport: { value: 'phone', isRotated: false } };

// The page's bar, which the actions sit in.
const inTopbar = createJSXDecorator(Story => (
  <TopbarFrame>
    <Story />
  </TopbarFrame>
));

const meta = {
  title: 'Host/Topbar/TopbarActions',
  component: Actions,
  parameters: { chrome: true, docs: { story: { inline: false, height: '560px' } } },
  tags: ['!autodocs'],
  globals: PHONE,
  decorators: [inTopbar],
  beforeEach: () => {
    resetStoryNetwork();
    resetStoryPermissions();
    resetStorySettings();
    resetStoryAccount();
    disconnect();
  },
} satisfies Meta<typeof Actions>;

export default meta;
type Story = StoryObj<typeof meta>;

// The bar of the host page stays live over the sheets resting on it, which the plays that press it need.
const barOverSheets = {
  beforeEach: () => () => {
    document.querySelector('body > [data-over-sheets]')?.removeAttribute('data-over-sheets');
  },
} satisfies Story;

/** As a phone user, I see the actions in the bar in place of the address while they fit, the account ending it. */
export const Default: Story = {};

/** As a phone user with no room in the bar, I see every action but the account behind More. */
export const IntoMore: Story = {
  args: { room: MORE_ONLY },
};

/** As a phone user, I find More raise the network's warning in its look and its name once a chain in use stalls. */
export const StalledNetworkRaisesMore: Story = {
  args: { room: MORE_ONLY },
  play: async ({ canvas, step }) => {
    await expectPhone(step);
    const more = await canvas.findByRole('button', { name: /^More/ });
    await step('Given the network is behind More and raises nothing', async () => {
      await reachable(more);
      await expect(more).not.toHaveAttribute('data-badge');
    });
    await step('When a chain in use stalls', () => {
      setHealth('warn');
    });
    await step('Then More carries the warning, and its name says the network is the cause', async () => {
      await waitFor(() => expect(more).toHaveAttribute('data-badge'));
      await expect(more).toHaveAttribute('data-tone', 'warn');
      await expect(more).toHaveAccessibleName(/network/);
    });
  },
};

/** As a phone keyboard user, Tab in the More sheet reaches its Close button, which hands focus back to More. */
export const TabReachesSheetClose: Story = {
  args: { room: MORE_ONLY },
  play: async ({ canvas, userEvent, step }) => {
    await expectPhone(step);
    const more = await canvas.findByRole('button', { name: /^More/ });
    const close = (): HTMLElement => within(byId('more-popover')).getByRole('button', { name: /^Close/ });
    await step('Given the More sheet opened from the keyboard', async () => {
      await reachable(more);
      more.focus();
      await userEvent.keyboard('{Enter}');
      await opened('more-popover');
    });
    await step('When I press Tab, then Enter on the button it reaches', async () => {
      await userEvent.tab();
      await waitFor(() => expect(close()).toHaveFocus());
      await userEvent.keyboard('{Enter}');
    });
    await step('Then the sheet closed and More has focus', async () => {
      await closed('more-popover');
      await waitFor(() => expect(more).toHaveFocus());
    });
  },
};

/** As a phone user with the Permissions sheet open, I press Settings in the bar and the sheets swap without sliding. */
export const BarPressSwapsSheets: Story = {
  ...barOverSheets,
  play: async ({ canvasElement, canvas, userEvent, step }) => {
    await expectPhone(step);
    await step('Given the Permissions sheet open from the bar, which stays live over it', async () => {
      keepBarLive(canvasElement);
      await openFromBar(await canvas.findByRole('button', { name: 'Permissions' }), 'permissions-popover', userEvent);
    });
    await step('When I press Settings in the bar', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /^Settings/ }));
    });
    await step('Then the settings sheet took its place with focus, both marked as a hand-off', async () => {
      await opened('mode-popover');
      await expect(byId('mode-popover')).toHaveAttribute('data-handoff');
      await expect(byId('permissions-popover')).not.toHaveAttribute('data-open');
      await expect(byId('permissions-popover')).toHaveAttribute('data-handoff');
      await waitFor(() => expect(byId('mode-popover').contains(document.activeElement)).toBe(true));
    });
  },
};

/** As a phone user with the Settings sheet open, I press Settings in the bar again and its sheet closes. */
export const BarPressClosesItsSheet: Story = {
  ...barOverSheets,
  play: async ({ canvasElement, canvas, userEvent, step }) => {
    await expectPhone(step);
    const settings = await canvas.findByRole('button', { name: /^Settings/ });
    await step('Given the Settings sheet open from the bar, which stays live over it', async () => {
      keepBarLive(canvasElement);
      await openFromBar(settings, 'mode-popover', userEvent);
    });
    await step('When I press Settings again', async () => {
      await userEvent.click(settings);
    });
    await step('Then its sheet closes', async () => {
      await closed('mode-popover');
    });
  },
};

/** As a phone user, I close with Escape a sheet that took More's place, and it slides out with no hand-off mark. */
export const ClosingSlidesOut: Story = {
  args: { room: MORE_ONLY },
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
      await expect(byId('permissions-popover')).not.toHaveAttribute('data-handoff');
    });
  },
};

/**
 * The actions as the host's island renders them, with the story's network, chat, permissions, settings and account.
 * Without a `room`, the group measures its own width, as the phone bar's room is.
 */
function Actions(props: { room?: number }): JSX.Element {
  return (
    <TopbarActions
      room={() => props.room}
      morph={STILL}
      network={<NetworkItem {...storyNetwork} />}
      chat={<ChatItem {...CHAT} />}
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

function opened(id: string): Promise<void> {
  return waitFor(() => expect(byId(id)).toHaveAttribute('data-open'));
}

function closed(id: string): Promise<void> {
  return waitFor(() => expect(byId(id)).not.toHaveAttribute('data-open'));
}

/** Marks the story's root as the bar, since on the host page the bar is the body's child that a sheet leaves live. */
function keepBarLive(canvasElement: HTMLElement): void {
  let root: HTMLElement = canvasElement;
  while (root.parentElement !== null && root.parentElement !== document.body) {
    root = root.parentElement;
  }
  root.setAttribute('data-over-sheets', '');
}

/** Presses `button` in the bar once it takes a pointer, and waits for its sheet `sheetId` with the bar still live. */
async function openFromBar(
  button: HTMLElement,
  sheetId: string,
  userEvent: Parameters<typeof openMore>[0],
): Promise<void> {
  await reachable(button);
  await userEvent.click(button);
  await opened(sheetId);
  await expect(button.closest('[inert]')).toBeNull();
}
