// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { iconMarkup, PERMISSION_ICONS } from '../../permission-icons.js';
import { IconTile } from './IconTile.js';

const meta = { title: 'Primitives/IconTile', component: IconTile, parameters: { chrome: true } } satisfies Meta<
  typeof IconTile
>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Markup: Story = { args: { markup: iconMarkup(PERMISSION_ICONS.Camera) } };
export const Children: Story = {
  render: args => (
    <IconTile {...args}>
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        aria-hidden="true"
      >
        <rect x="4" y="11" width="16" height="10" rx="3" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
    </IconTile>
  ),
};
