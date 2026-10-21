// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
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

/** As a dotli user, I see a neutral chip and read its text. */
export const Default: Story = {};
/** As a dotli user, I see a verified chip drawn in the ok tone. */
export const Ok: Story = { args: { tone: 'ok', children: 'Verified' } };
/** As a dotli user, I see a local-account chip drawn in the warn tone. */
export const Warn: Story = { args: { tone: 'warn', children: 'Local account' } };
/** As a dotli user, I see an address chip drawn in monospace. */
export const Mono: Story = { args: { tone: 'mono', children: '0x1a2b…9f' } };
