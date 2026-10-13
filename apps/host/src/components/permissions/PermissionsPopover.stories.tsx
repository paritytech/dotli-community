// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, flush } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { openSurface, TopbarFrame } from '../../../.storybook/topbar-frame.js';
import { PermissionsPopover } from './PermissionsPopover.js';

const open = openSurface({ trigger: 'permissions-button', surface: 'permissions-popover' });

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`No #${id}`);
  }
  return found;
}

const [hasGrants, setHasGrantsSignal] = createSignal(false);

function setHasGrants(next: boolean): void {
  setHasGrantsSignal(next);
  flush();
}

/** The button with a body standing in for the page's panel. */
function StoryButton(): JSX.Element {
  return (
    <PermissionsPopover hasGrants={hasGrants}>
      <p data-testid="story-permissions-body">Granted to this app</p>
    </PermissionsPopover>
  );
}

const meta = {
  title: 'Host/Permissions/PermissionsPopover',
  component: StoryButton,
  parameters: { chrome: true, docs: { story: { inline: false, height: '240px' } } },
  beforeEach: () => {
    setHasGrants(false);
  },
  render: () => (
    <TopbarFrame>
      <StoryButton />
    </TopbarFrame>
  ),
} satisfies Meta<typeof StoryButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, the lock button announces the dialog it opens, which shows the body the page gives it. */
export const OpensBody: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    const button = el('permissions-button');
    await ctx.step('Given the button announces the closed dialog it opens', async () => {
      await expect(button).toHaveAttribute('title', 'Permissions');
      await expect(button).toHaveAttribute('aria-label', 'Permissions');
      await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      await expect(button).toHaveAttribute('aria-controls', 'permissions-popover');
    });
    await open(ctx);
    await ctx.step('Then it is the open dialog named Permissions, showing the body', async () => {
      const popover = el('permissions-popover');
      await expect(button).toHaveAttribute('aria-expanded', 'true');
      await expect(popover).toHaveAttribute('role', 'dialog');
      await expect(popover).toHaveAttribute('aria-label', 'Permissions');
      await expect(within(popover).getByTestId('story-permissions-body')).toHaveTextContent('Granted to this app');
    });
  },
};

/** As a user, the lock button shows its grants badge only while the app has a permission granted. */
export const GrantsBadge: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    const button = el('permissions-button');
    await step('Given no grant, then no badge', async () => {
      await expect(button).not.toHaveAttribute('data-badge');
    });
    await step('When the app has a grant', () => {
      setHasGrants(true);
    });
    await step('Then the badge shows', async () => {
      await waitFor(() => expect(button).toHaveAttribute('data-badge'));
    });
    await step('When the grant goes', () => {
      setHasGrants(false);
    });
    await step('Then the badge goes', async () => {
      await waitFor(() => expect(button).not.toHaveAttribute('data-badge'));
    });
  },
};
