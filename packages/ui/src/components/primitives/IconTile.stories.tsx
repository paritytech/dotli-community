// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect } from 'storybook/test';
import { GlobeIcon } from '../icons/GlobeIcon.js';
import { LockIcon } from '../icons/LockIcon.js';
import { IconTile } from './IconTile.js';

const meta = { title: 'Primitives/IconTile', component: IconTile, parameters: { chrome: true } } satisfies Meta<
  typeof IconTile
>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Icon: Story = {
  args: { icon: GlobeIcon, testId: 'tile' },
  play: async ({ canvas, step }) => {
    await step('Then I see the icon in its tile, which assistive technology skips', async () => {
      const tile = canvas.getByTestId('tile');
      await expect(tile).toHaveAttribute('aria-hidden', 'true');
      await expect(tile.querySelector('svg')).not.toBeNull();
    });
  },
};
export const Children: Story = {
  args: { testId: 'tile' },
  play: async ({ canvas, step }) => {
    await step('Then I see the drawn icon in the same tile, which assistive technology skips', async () => {
      const tile = canvas.getByTestId('tile');
      await expect(tile).toHaveAttribute('aria-hidden', 'true');
      await expect(tile.querySelector('svg')).not.toBeNull();
    });
  },
  render: args => (
    <IconTile {...args}>
      <LockIcon size={20} />
    </IconTile>
  ),
};
