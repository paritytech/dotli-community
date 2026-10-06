// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { fn } from 'storybook/test';
import { ChatActionButton } from './ChatActionButton.js';

const meta = {
  title: 'Primitives/ChatActionButton',
  component: ChatActionButton,
  args: { variant: 'primary', onClick: fn(), children: 'Approve' },
  argTypes: { variant: { control: 'inline-radio', options: ['primary', 'secondary', 'text'] } },
} satisfies Meta<typeof ChatActionButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};
export const Secondary: Story = { args: { variant: 'secondary', children: 'Later' } };
export const Text: Story = { args: { variant: 'text', children: 'Details' } };
export const Loading: Story = { args: { loading: true } };
export const Disabled: Story = { args: { disabled: true } };
