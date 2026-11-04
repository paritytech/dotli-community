// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { byId } from '@dotli/ui/testing';
import { TopbarFrame } from '../../testing/stories/topbarFrame.js';
import { productPill, setShield, storyShieldState } from '../../testing/stories/shieldFixtures.js';
import { VERIFICATION_SHIELD_ID } from './verificationShieldIds.js';
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
export const Verified: Story = {
  play: async ({ step }) => {
    await step('As a visitor, the shield is named "Secure connection"', async () => {
      // Given a product verified by the light client

      // When the shield shows
      const shield = within(document.body).getByRole('img', { name: 'Secure connection' });

      // Then the shield is the named glyph in the verified state
      await expect(shield).toBe(byId(VERIFICATION_SHIELD_ID));
      await expect(shield).toHaveAttribute('data-state', 'verified');
    });
  },
};

/** As a visitor, I see a product served by an external RPC provider as a trusted connection, and it follows the state. */
export const Trusted: Story = {
  play: async ({ step }) => {
    await step('As a visitor, the shield is named "Trusted connection" once the host trusts the provider', async () => {
      // Given a product verified by the light client

      // When the host falls back to an external RPC provider
      setShield('trusted');

      // Then the shield is the named glyph in the trusted state
      const shield = await waitFor(() => within(document.body).getByRole('img', { name: 'Trusted connection' }));
      await expect(shield).toBe(byId(VERIFICATION_SHIELD_ID));
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
      const shield = byId(VERIFICATION_SHIELD_ID);

      // Then the shield is hidden from screen readers and has no state
      await expect(shield).toHaveAttribute('aria-hidden', 'true');
      await expect(shield).not.toHaveAttribute('role');
      await expect(shield).not.toHaveAttribute('data-state');
      await expect(within(document.body).queryByRole('img')).toBeNull();
    });
  },
};
