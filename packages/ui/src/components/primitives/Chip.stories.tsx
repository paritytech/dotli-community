// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect } from 'storybook/test';
import { Chip } from './Chip.js';

const meta = {
  title: 'Primitives/Chip',
  parameters: { chrome: true },
  component: Chip,
  args: { children: 'Paseo' },
  argTypes: { tone: { control: 'inline-radio', options: ['default', 'ok', 'warn', 'mono'] } },
} satisfies Meta<typeof Chip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { testId: 'chip' },
  play: async ({ canvas, step }) => {
    await step('Then I read the chip text', async () => {
      await expect(canvas.getByTestId('chip')).toHaveTextContent('Paseo');
    });
  },
};
export const Ok: Story = { args: { tone: 'ok', children: 'Verified' } };
export const Warn: Story = { args: { tone: 'warn', children: 'Local account' } };
export const Mono: Story = { args: { tone: 'mono', children: '0x1a2b…9f' } };
