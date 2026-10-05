// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { Chip } from './Chip.js';

const meta = {
  title: 'Primitives/Chip',
  parameters: { chrome: true },
  component: Chip,
  args: { children: 'Paseo' },
  argTypes: { tone: { control: 'inline-radio', options: ['default', 'ok', 'mono'] } },
} satisfies Meta<typeof Chip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Ok: Story = { args: { tone: 'ok', children: 'Verified' } };
export const Mono: Story = { args: { tone: 'mono', children: '0x1a2b…9f' } };
