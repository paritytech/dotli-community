// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor } from 'storybook/test';
import { TopbarFrame } from '../../../.storybook/topbar-frame.js';
import { noProductPill, productPill, setShield, storyShield } from '../../../.storybook/shield-fixtures.js';
import { UrlPillShield } from './UrlPillShield.js';

const shield = (): HTMLElement | null => document.getElementById('verification-shield');

const meta = {
  title: 'Host/Shield/UrlPillShield',
  component: UrlPillShield,
  parameters: { chrome: true, docs: { story: { inline: false, height: '120px' } } },
  tags: ['!autodocs'],
  args: { shield: storyShield },
  beforeEach: () => {
    noProductPill();
  },
  render: () => (
    <TopbarFrame center>
      <UrlPillShield shield={storyShield} />
    </TopbarFrame>
  ),
} satisfies Meta<typeof UrlPillShield>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a visitor of a product, the shield shows in the state the host set, from before or after it mounts. */
export const ProductShield: Story = {
  beforeEach: () => {
    productPill();
    setShield('verified');
  },
  play: async ({ step }) => {
    await step('Then the shield shows the state set before it mounted', async () => {
      await waitFor(() => expect(shield()).toHaveAttribute('data-state', 'verified'));
    });
    await step('When the host marks the product trusted', () => {
      setShield('trusted');
    });
    await step('Then the shield follows', async () => {
      await waitFor(() => expect(shield()).toHaveAttribute('data-state', 'trusted'));
    });
  },
};

/** As a developer on a localhost proxy, or before a product loads, there is no shield. */
export const NoShieldOnLocalhost: Story = {
  play: async ({ step }) => {
    await step('Then no shield shows before a product loads', async () => {
      await expect(shield()).toBeNull();
    });
    await step('When the pill shows a localhost proxy', () => {
      noProductPill();
    });
    await step('Then there is still no shield', async () => {
      await expect(shield()).toBeNull();
    });
    await step('When a product loads', () => {
      productPill();
    });
    await step('Then the shield shows with no state yet', async () => {
      await waitFor(() => expect(shield()).not.toBeNull());
      await expect(shield()).not.toHaveAttribute('data-state');
    });
  },
};
