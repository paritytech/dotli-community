// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect } from 'storybook/test';
import { Logo } from './Logo.js';

const meta = {
  title: 'Brand/Logo',
  component: Logo,
  parameters: { chrome: true },
  args: { variant: 'full', height: 28 },
} satisfies Meta<typeof Logo>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a dotli user, I see the Polkadot logo with its word. */
export const Full: Story = {};

/** As a dotli user, I see the Polkadot logo with the Beta tag at the end of the word. */
export const FullBeta: Story = {
  args: { beta: true },
  play: async ({ canvas, step }) => {
    await step('Then the Beta tag shows', async () => {
      await expect(canvas.getByTestId('logo-beta')).toBeVisible();
    });
  },
};

/** As a dotli user, I see the Polkadot symbol alone. */
export const SymbolAlone: Story = {
  args: { variant: 'symbol' },
};

/** As a dotli user, I see the Polkadot symbol with the Beta tag past its top-right corner. */
export const SymbolBeta: Story = {
  args: { variant: 'symbol', beta: true },
};
