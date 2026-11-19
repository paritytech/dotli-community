// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect } from 'storybook/test';
import { LogoSymbol } from './LogoSymbol.js';

const meta = { title: 'Brand/LogoSymbol', component: LogoSymbol, parameters: { chrome: true } } satisfies Meta<
  typeof LogoSymbol
>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a dotli user, I see the dot.li symbol. */
export const Default: Story = {};

/** As a dotli user, I see the dot.li symbol at the header's size with the Beta tag on its corner. */
export const Beta: Story = {
  args: { height: 28, beta: true },
  play: async ({ canvas, step }) => {
    await step('Then the Beta tag shows', async () => {
      await expect(canvas.getByTestId('logo-symbol-beta')).toBeVisible();
    });
  },
};
