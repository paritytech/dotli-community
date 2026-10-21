// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { byId } from '@dotli/ui/testing';
import { resetStoryNetwork, setHealth, storyNetwork } from '../../testing/stories/network-fixtures.js';
import { openSurface, TopbarFrame } from '../../testing/stories/topbar-frame.js';
import { NetworkItem } from './NetworkItem.js';

const open = openSurface({ trigger: 'chains-button', surface: 'chains-popover' });

/** The item as the page gives it its network. */
function StoryItem(): JSX.Element {
  return <NetworkItem {...storyNetwork} />;
}

const meta = {
  title: 'Host/Network/NetworkItem',
  component: StoryItem,
  parameters: { chrome: true, docs: { story: { inline: false, height: '240px' } } },
  beforeEach: () => {
    resetStoryNetwork();
  },
  render: () => (
    <TopbarFrame>
      <StoryItem />
    </TopbarFrame>
  ),
} satisfies Meta<typeof StoryItem>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a visitor, the network button announces the dialog named Network it opens, which shows the network panel. */
export const OpensBody: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    const button = byId('chains-button');
    await ctx.step('Given the button with its labels and ARIA', async () => {
      await expect(button).toHaveAttribute('title', 'Network');
      await expect(button).toHaveAttribute('aria-label', 'Network');
      await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      await expect(button).toHaveAttribute('aria-controls', 'chains-popover');
    });
    await open(ctx);
    await ctx.step('Then it announces the open dialog named Network, showing the panel', async () => {
      const popover = byId('chains-popover');
      await expect(button).toHaveAttribute('aria-expanded', 'true');
      await expect(popover).toHaveAttribute('role', 'dialog');
      await expect(popover).toHaveAttribute('aria-label', 'Network');
      await expect(popover).toHaveAttribute('tabindex', '-1');
      await expect(within(popover).getByTestId('chains-content')).toBeInTheDocument();
    });
  },
};

/** As a visitor, the button's badge always shows, in the tone of the network's health. */
export const BadgeFollowsHealth: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    const button = byId('chains-button');
    await step('Given no chain in use, then the badge is quiet', async () => {
      await expect(button).toHaveAttribute('data-badge');
      await expect(button).toHaveAttribute('data-tone', 'quiet');
    });
    for (const tone of ['idle', 'ok', 'warn', 'err'] as const) {
      await step(`When the health is ${tone}, then the badge takes its tone`, async () => {
        setHealth(tone);
        await waitFor(() => expect(button).toHaveAttribute('data-tone', tone));
        await expect(button).toHaveAttribute('data-badge');
      });
    }
  },
};
