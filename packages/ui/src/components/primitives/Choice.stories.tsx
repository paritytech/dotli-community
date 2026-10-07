// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect } from 'storybook/test';
import { Chip } from './Chip.js';
import { VerifiedShieldIcon } from '../shell/ShieldIcons.js';
import { Choice } from './Choice.js';

const meta = {
  title: 'Primitives/Choice',
  parameters: { chrome: true },
  component: Choice,
  args: {
    title: 'Light client per tab',
    description: 'Verified in your browser, separate for each tab',
    selected: false,
  },
} satisfies Meta<typeof Choice>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Plain: Story = {};
export const Selected: Story = { args: { selected: true } };
export const WithChip: Story = {
  args: { selected: true },
  render: args => <Choice {...args} chip={<Chip tone="ok">Recommended</Chip>} />,
};

// The verification explainer's card for the way this site was loaded.
export const WithIcon: Story = {
  args: {
    title: 'Verified',
    description: 'Checked in your browser by the light client. The more secure option.',
    selected: true,
  },
  render: args => (
    <Choice
      {...args}
      chip={<Chip>This site</Chip>}
      icon={
        <span style={{ display: 'inline-flex', color: 'var(--chrome-ok)' }}>
          <VerifiedShieldIcon size={16} strokeWidth="1.75" />
        </span>
      }
    />
  ),
};

const TRANSPORTS = [
  { value: 'per-tab', title: 'Light client per tab', description: 'Verified in your browser, separate for each tab' },
  { value: 'shared', title: 'Light client shared', description: 'Verified in your browser, shared across tabs' },
  {
    value: 'gateway',
    title: 'Trusted providers',
    description: 'Fetched from trusted servers. Fastest, but less private',
  },
] as const;

export const RadioGroup: Story = {
  render: () => {
    const [value, setValue] = createSignal<string>('per-tab');
    return (
      <div role="radiogroup" aria-label="Transport" style={{ display: 'grid', gap: '8px', 'max-width': '360px' }}>
        <For each={TRANSPORTS} keyed={false}>
          {option => (
            <Choice
              title={option().title}
              description={option().description}
              selected={value() === option().value}
              radio={{
                name: 'transport',
                value: option().value,
                onChoose: () => setValue(option().value),
              }}
            />
          )}
        </For>
      </div>
    );
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('Given the first transport is chosen', async () => {
      await expect(canvas.getByRole('radio', { name: /Light client per tab/ })).toBeChecked();
    });
    await step('When I pick Trusted providers', async () => {
      await userEvent.click(canvas.getByRole('radio', { name: /Trusted providers/ }));
    });
    await step('Then it is the chosen one', async () => {
      await expect(canvas.getByRole('radio', { name: /Trusted providers/ })).toBeChecked();
      await expect(canvas.getByRole('radio', { name: /Light client per tab/ })).not.toBeChecked();
    });
  },
};
