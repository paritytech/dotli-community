// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { SLIDERS_PATH } from '../../settings-glyph.js';
import { CloseIcon, IconButton } from './IconButton.js';

// The board's sliders glyph, as the Settings button draws it.
const Sliders = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
    <path d={SLIDERS_PATH} />
  </svg>
);

const meta = {
  title: 'Primitives/IconButton',
  parameters: { chrome: true },
  component: IconButton,
  args: { 'aria-label': 'Settings', onClick: fn() },
  // Icons render per story, since one node in the args would move between
  // every button that shows it.
  render: args => (
    <IconButton {...args}>
      <Sliders />
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
            <Sliders />
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
