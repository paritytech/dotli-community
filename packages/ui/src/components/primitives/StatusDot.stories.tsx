// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect } from 'storybook/test';
import { StatusDot } from './StatusDot.js';

const TONES = ['ok', 'warn', 'err', 'info', 'idle'] as const;

const meta = {
  title: 'Primitives/StatusDot',
  parameters: { chrome: true },
  component: StatusDot,
  args: { tone: 'ok', label: 'In sync' },
  argTypes: {
    tone: { control: 'inline-radio', options: TONES },
    size: { control: 'inline-radio', options: ['md', 'sm'] },
  },
} satisfies Meta<typeof StatusDot>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a dotli user, I see a status dot in every tone and tell the tones apart. */
export const Tones: Story = {
  render: args => (
    <div style={{ display: 'flex', gap: '16px' }}>
      <For each={TONES} keyed={false}>
        {tone => <StatusDot {...args} tone={tone()} label={tone()} />}
      </For>
    </div>
  ),
};
/** As a dotli user, I see the small status dot. */
export const Small: Story = { args: { size: 'sm' } };
/** As a dotli user, I see a pulsing warn dot named Syncing while something is in progress. */
export const Pulse: Story = { args: { tone: 'warn', pulse: true, label: 'Syncing' } };

// With no label it only repeats the text beside it.
/** As a screen reader user, I skip a status dot that has no label, since the text beside it says the same. */
export const Decorative: Story = {
  render: () => <StatusDot tone="warn" testId="dot" />,
  play: async ({ canvas, step }) => {
    await step('Then assistive technology skips the dot', async () => {
      await expect(canvas.getByTestId('dot')).toHaveAttribute('aria-hidden', 'true');
      await expect(canvas.queryByRole('img')).toBeNull();
    });
  },
};
