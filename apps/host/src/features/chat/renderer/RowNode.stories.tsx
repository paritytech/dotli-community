// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { dot, frame, inTreeFrame } from '../../../testing/stories/rendererFixtures.js';
import { BoxNode } from './BoxNode.js';
import { RowNode } from './RowNode.js';

const meta = {
  title: 'Entities/Chat/Renderer/RowNode',
  component: RowNode,
  parameters: { chrome: true },
  args: { value: { modifiers: frame(48), props: {} } },
  decorators: [inTreeFrame],
  render: args => (
    <RowNode {...args}>
      <BoxNode value={dot()} />
      <BoxNode value={dot(24, 32)} />
      <BoxNode value={dot()} />
    </RowNode>
  ),
} satisfies Meta<typeof RowNode>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see a product row that names no arrangement place its children side by side from its start. */
export const Default: Story = {};

/** As a user, I see a product row space its children evenly and centre them on its height. */
export const SpacedEvenly: Story = {
  args: {
    value: { ...meta.args.value, props: { horizontalArrangement: 'SpaceEvenly', verticalAlignment: 'Center' } },
  },
};
