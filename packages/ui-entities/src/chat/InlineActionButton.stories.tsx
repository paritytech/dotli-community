// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { fn } from 'storybook/test';
import { InlineActionButton } from './InlineActionButton.js';

const meta = {
  title: 'Entities/Chat/InlineActionButton',
  component: InlineActionButton,
  args: { variant: 'primary', onClick: fn(), children: 'Approve' },
  argTypes: { variant: { control: 'inline-radio', options: ['primary', 'secondary', 'text'] } },
} satisfies Meta<typeof InlineActionButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};
export const Secondary: Story = { args: { variant: 'secondary', children: 'Later' } };
export const Text: Story = { args: { variant: 'text', children: 'Details' } };
export const Loading: Story = { args: { loading: true } };
export const Disabled: Story = { args: { disabled: true } };
