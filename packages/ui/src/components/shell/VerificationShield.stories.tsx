// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor } from 'storybook/test';
import { TopbarFrame, expectPhone, openSurface } from '../../../.storybook/shell-fixtures.js';
import { resetAllStoresForTests } from '../../state/create-store.js';
import { setVerificationShieldState, showProductPill } from '../../state/url-pill.js';
import { VerificationShield } from './VerificationShield.js';

const shown = openSurface({ surface: 'verification-tooltip' });

/** A click leaves a tooltip alone, so this hovers with trusted input, which the real `:hover` needs. */
const open: typeof shown = async ctx => {
  await ctx.step('When the mouse rests on the shield', async () => {
    const { userEvent } = await import('vitest/browser');
    const shield = document.getElementById('verification-shield');
    if (shield === null) {
      throw new Error('no verification shield');
    }
    await userEvent.hover(shield);
  });
  await shown(ctx);
  await ctx.step('And its body has loaded', async () => {
    await waitFor(() =>
      expect(document.querySelector('[data-testid="verification-tooltip-row-verified"]')).not.toBeNull(),
    );
  });
};

const meta = {
  title: 'Shell/VerificationShield',
  component: VerificationShield,
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  beforeEach: () => {
    showProductPill('example', 'dot');
    setVerificationShieldState('verified');
    return resetAllStoresForTests;
  },
  render: () => (
    <TopbarFrame center>
      <VerificationShield />
    </TopbarFrame>
  ),
} satisfies Meta<typeof VerificationShield>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    await open(ctx);
  },
};

export const OpenPhone: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ctx => {
    await expectPhone(ctx.step);
    await open(ctx);
  },
};
