// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { byId } from '@dotli/ui/testing';
import { givenApp, resetStoryPermissions, storyPermissions } from '../../../.storybook/permissions-fixtures.js';
import { openSurface, TopbarFrame } from '../../../.storybook/topbar-frame.js';
import { PermissionsItem } from './PermissionsItem.js';

const open = openSurface({ trigger: 'permissions-button', surface: 'permissions-popover' });

/** The item as the page gives it the product's permissions. */
function StoryItem(): JSX.Element {
  return <PermissionsItem {...storyPermissions} />;
}

const meta = {
  title: 'Host/Permissions/PermissionsItem',
  component: StoryItem,
  parameters: { chrome: true, docs: { story: { inline: false, height: '240px' } } },
  beforeEach: () => {
    resetStoryPermissions();
  },
  render: () => (
    <TopbarFrame>
      <StoryItem />
    </TopbarFrame>
  ),
} satisfies Meta<typeof StoryItem>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, the lock button announces the dialog it opens, which shows the permissions panel. */
export const OpensBody: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    const button = byId('permissions-button');
    await ctx.step('Given the button announces the closed dialog it opens', async () => {
      await expect(button).toHaveAttribute('title', 'Permissions');
      await expect(button).toHaveAttribute('aria-label', 'Permissions');
      await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      await expect(button).toHaveAttribute('aria-controls', 'permissions-popover');
    });
    await open(ctx);
    await ctx.step('Then it is the open dialog named Permissions, showing the panel', async () => {
      const popover = byId('permissions-popover');
      await expect(button).toHaveAttribute('aria-expanded', 'true');
      await expect(popover).toHaveAttribute('role', 'dialog');
      await expect(popover).toHaveAttribute('aria-label', 'Permissions');
      await expect(within(popover).getByTestId('permissions-popover-header')).toBeInTheDocument();
    });
  },
};

/** As a user, the lock button shows its grants badge only while the app has a permission granted. */
export const GrantsBadge: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    const button = byId('permissions-button');
    await step('Given no grant, then no badge', async () => {
      await expect(button).not.toHaveAttribute('data-badge');
    });
    await step('When the app has a grant', () => {
      givenApp({ Clipboard: 'granted' });
    });
    await step('Then the badge shows', async () => {
      await waitFor(() => expect(button).toHaveAttribute('data-badge'));
    });
    await step('When the grant goes', () => {
      givenApp();
    });
    await step('Then the badge goes', async () => {
      await waitFor(() => expect(button).not.toHaveAttribute('data-badge'));
    });
  },
};
