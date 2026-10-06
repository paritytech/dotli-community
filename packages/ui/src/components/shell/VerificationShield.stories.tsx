// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { TopbarFrame, expectPhone, openSurface } from '../../../.storybook/shell-fixtures.js';
import { resetAllStoresForTests } from '../../state/create-store.js';
import { setVerificationShieldState, showProductPill } from '../../state/url-pill.js';
import { VerificationShield } from './VerificationShield.js';

const shown = openSurface({ surface: 'verification-tooltip' });

/**
 * The explainer is a tooltip, which a mouse click leaves alone: the `Open`
 * play rests the mouse on the shield (trusted input, so the real `:hover`
 * shows), then waits for the explainer and its body.
 */
const open: typeof shown = async ctx => {
  await ctx.step('When the mouse rests on the shield', async () => {
    const { userEvent } = await import('vitest/browser');
    await userEvent.hover(within(document.body).getByRole('button', { name: /How was this site loaded/ }));
  });
  await shown(ctx);
  await ctx.step('And its body has loaded', async () => {
    await waitFor(() => expect(document.querySelector('[data-testid="verification-tooltip-title"]')).not.toBeNull());
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
