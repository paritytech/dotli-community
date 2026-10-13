// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, flush } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { openSurface, TopbarFrame } from '../../../.storybook/topbar-frame.js';
import type { NetworkHealth } from '@dotli/ui-entities';
import { ChainsPopover } from './ChainsPopover.js';

const open = openSurface({ trigger: 'chains-button', surface: 'chains-popover' });

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`No #${id}`);
  }
  return found;
}

const [health, setHealthSignal] = createSignal<NetworkHealth>('quiet');

function setHealth(next: NetworkHealth): void {
  setHealthSignal(next);
  flush();
}

/** The button with a body standing in for the page's panel. */
function StoryButton(): JSX.Element {
  return (
    <ChainsPopover health={health}>
      <p data-testid="story-chains-body">Relay chain</p>
    </ChainsPopover>
  );
}

const meta = {
  title: 'Host/Network/ChainsPopover',
  component: StoryButton,
  parameters: { chrome: true, docs: { story: { inline: false, height: '240px' } } },
  beforeEach: () => {
    setHealth('quiet');
  },
  render: () => (
    <TopbarFrame>
      <StoryButton />
    </TopbarFrame>
  ),
} satisfies Meta<typeof StoryButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a visitor, the network button announces the dialog named Network it opens, which shows the page's body. */
export const OpensBody: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    const button = el('chains-button');
    await ctx.step('Given the button with its labels and ARIA', async () => {
      await expect(button).toHaveAttribute('title', 'Network');
      await expect(button).toHaveAttribute('aria-label', 'Network');
      await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      await expect(button).toHaveAttribute('aria-controls', 'chains-popover');
    });
    await open(ctx);
    await ctx.step('Then it announces the open dialog named Network, showing the body', async () => {
      const popover = el('chains-popover');
      await expect(button).toHaveAttribute('aria-expanded', 'true');
      await expect(popover).toHaveAttribute('role', 'dialog');
      await expect(popover).toHaveAttribute('aria-label', 'Network');
      await expect(within(popover).getByTestId('story-chains-body')).toHaveTextContent('Relay chain');
    });
  },
};

/** As a visitor, the button's badge always shows, in the tone of the network's health. */
export const BadgeFollowsHealth: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    const button = el('chains-button');
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
