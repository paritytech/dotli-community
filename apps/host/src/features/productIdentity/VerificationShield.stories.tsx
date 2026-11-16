// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { byTestId } from '@dotli/ui/testing';
import { TopbarFrame } from '../../testing/stories/topbarFrame.js';
import { productPill, setShield, storyShieldState } from '../../testing/stories/shieldFixtures.js';
import { VerificationShield } from './VerificationShield.js';

const meta = {
  title: 'Host/Shield/VerificationShield',
  component: VerificationShield,
  parameters: { chrome: true, docs: { story: { inline: false, height: '120px' } } },
  args: { state: storyShieldState },
  beforeEach: () => {
    productPill();
    setShield('verified');
  },
  render: () => (
    <TopbarFrame center>
      <VerificationShield state={storyShieldState} />
    </TopbarFrame>
  ),
} satisfies Meta<typeof VerificationShield>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a visitor, I see a product served by the light client as a secure connection. */
export const Verified: Story = {};

/** As a visitor, I see a product served by an external RPC provider as a trusted connection, and it follows the state. */
export const Trusted: Story = {
  play: async ({ step }) => {
    await step('As a visitor, the shield is named "Trusted connection" once the host trusts the provider', async () => {
      // Given a product verified by the light client

      // When the host falls back to an external RPC provider
      setShield('trusted');

      // Then the shield is the named glyph in the trusted state
      const shield = await waitFor(() => within(document.body).getByRole('img', { name: 'Trusted connection' }));
      await expect(shield).toBe(byTestId('verification-shield'));
      await expect(shield).toHaveAttribute('data-state', 'trusted');
    });
  },
};

/** As a screen-reader user, I do not hear a shield before the host knows how the product loaded. */
export const Pending: Story = {
  beforeEach: () => {
    productPill();
  },
  play: async ({ step }) => {
    await step('As a screen-reader user, the shield is hidden while the state is null', async () => {
      // Given a product whose load state is not known yet

      // When the shield shows
      const shield = byTestId('verification-shield');

      // Then the shield is hidden from screen readers and has no state
      await expect(shield).toHaveAttribute('aria-hidden', 'true');
      await expect(shield).not.toHaveAttribute('role');
      await expect(shield).not.toHaveAttribute('data-state');
      await expect(within(document.body).queryByRole('img')).toBeNull();
    });
  },
};

// Inline, so the story loads no image from the network.
const ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#e6007a"/></svg>',
  );

/**
 * As a visitor of a product with an icon, I see the icon in the shield's place, marked with a warning shield once the
 * product is only trusted.
 */
export const ProductIcon: Story = {
  render: () => (
    <TopbarFrame center>
      <VerificationShield state={storyShieldState} icon={() => ICON} />
    </TopbarFrame>
  ),
  play: async ({ step }) => {
    await step('As a visitor, a verified product shows its icon with no warning', async () => {
      // Given a product verified by the light client, with an icon

      // When the shield shows
      const shield = within(document.body).getByRole('img', { name: 'Secure connection' });

      // Then the icon takes the glyph's place and the warning badge is hidden
      await expect(within(shield).getByTestId('url-pill-icon')).toBeVisible();
      await expect(within(shield).queryByTestId('verification-shield-icon')).toBeNull();
      await expect(within(shield).getByTestId('url-pill-trusted-badge')).not.toBeVisible();
    });
    await step('As a visitor, a trusted product marks its icon with the warning shield', async () => {
      // Given a product with an icon

      // When the host falls back to an external RPC provider
      setShield('trusted');

      // Then the warning badge shows on the icon
      const shield = await waitFor(() => within(document.body).getByRole('img', { name: 'Trusted connection' }));
      await expect(within(shield).getByTestId('url-pill-trusted-badge')).toBeVisible();
    });
  },
};
