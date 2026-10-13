// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { CloseIcon } from '../icons/CloseIcon.js';
import { SlidersIcon } from '../icons/SlidersIcon.js';
import { IconButton } from './IconButton.js';

const meta = {
  title: 'Primitives/IconButton',
  parameters: { chrome: true },
  component: IconButton,
  args: { 'aria-label': 'Settings', onClick: fn() },
  // Per story, since one node in the args would move between every button that shows it.
  render: args => (
    <IconButton {...args}>
      <SlidersIcon />
    </IconButton>
  ),
} satisfies Meta<typeof IconButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvas, userEvent, step }) => {
    await step('When I press it', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Settings' }));
    });
    await step('Then its handler runs', async () => {
      await expect(args.onClick).toHaveBeenCalledOnce();
    });
  },
};
export const Badges: Story = {
  render: args => (
    <div style={{ display: 'flex', gap: '12px' }}>
      <For each={['ok', 'warn', 'err', 'info', 'idle'] as const} keyed={false}>
        {tone => (
          <IconButton {...args} aria-label={`Settings, ${tone()}`} badge badgeTone={tone()}>
            <SlidersIcon />
          </IconButton>
        )}
      </For>
    </div>
  ),
};
export const Small: Story = {
  args: { size: 'sm', 'aria-label': 'Close' },
  render: args => (
    <IconButton {...args}>
      <CloseIcon />
    </IconButton>
  ),
};

export const InForm: Story = {
  args: { 'aria-label': 'Clear' },
  render: args => {
    const [submitted, setSubmitted] = createSignal(false);
    return (
      <form
        data-testid="form"
        data-submitted={submitted() ? '' : undefined}
        onSubmit={ev => {
          ev.preventDefault();
          setSubmitted(true);
        }}
      >
        <IconButton {...args}>
          <CloseIcon />
        </IconButton>
      </form>
    );
  },
  play: async ({ args, canvas, userEvent, step }) => {
    await step('When I press the icon button in a form', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Clear' }));
    });
    await step('Then its handler runs and the form is not submitted', async () => {
      await expect(args.onClick).toHaveBeenCalledOnce();
      await expect(canvas.getByTestId('form')).not.toHaveAttribute('data-submitted');
    });
  },
};
