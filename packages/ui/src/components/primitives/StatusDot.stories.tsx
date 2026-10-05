// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { StatusDot } from './StatusDot.js';

const TONES = ['ok', 'warn', 'err', 'info', 'idle'] as const;

const meta = {
  title: 'Primitives/StatusDot',
  component: StatusDot,
  args: { tone: 'ok', label: 'In sync' },
  argTypes: {
    tone: { control: 'inline-radio', options: TONES },
    size: { control: 'inline-radio', options: ['md', 'sm'] },
  },
} satisfies Meta<typeof StatusDot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Tones: Story = {
  render: args => (
    <div style={{ display: 'flex', gap: '16px' }}>
      <For each={TONES} keyed={false}>
        {tone => <StatusDot {...args} tone={tone()} label={tone()} />}
      </For>
    </div>
  ),
};
export const Small: Story = { args: { size: 'sm' } };
export const Pulse: Story = { args: { tone: 'warn', pulse: true, label: 'Syncing' } };
