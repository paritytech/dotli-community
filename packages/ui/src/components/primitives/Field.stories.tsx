// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { Field } from './Field.js';

const meta = {
  title: 'Primitives/Field',
  component: Field,
  args: { label: 'Application', value: 'playground.dot' },
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Plain: Story = {};
export const Mono: Story = {
  args: { label: 'Account', value: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY', mono: true },
};
export const Warning: Story = { args: { label: 'Network', value: 'Unknown chain', warning: true } };
export const LongValue: Story = {
  args: { label: 'Call data', value: `0x${'0a1b2c3d4e5f'.repeat(24)}`, mono: true },
};
