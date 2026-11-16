// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect } from 'storybook/test';
import { Spinner } from './Spinner.js';

const meta = { title: 'Primitives/Spinner', component: Spinner, parameters: { chrome: true } } satisfies Meta<
  typeof Spinner
>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a dotli user, I see a spinner while something loads, which assistive technology skips. */
export const Default: Story = {
  args: { testId: 'spinner' },
  play: async ({ canvas, step }) => {
    await step('Then assistive technology skips the spinner', async () => {
      await expect(canvas.getByTestId('spinner')).toHaveAttribute('aria-hidden', 'true');
    });
  },
};
