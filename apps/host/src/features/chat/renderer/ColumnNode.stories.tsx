// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { dot, frame, inTreeFrame } from '../../../testing/stories/rendererFixtures.js';
import { BoxNode } from './BoxNode.js';
import { ColumnNode } from './ColumnNode.js';

const meta = {
  title: 'Entities/Chat/Renderer/ColumnNode',
  component: ColumnNode,
  parameters: { chrome: true },
  args: { value: { modifiers: frame(120), props: {} } },
  decorators: [inTreeFrame],
  render: args => (
    <ColumnNode {...args}>
      <BoxNode value={dot()} />
      <BoxNode value={dot(40)} />
      <BoxNode value={dot()} />
    </ColumnNode>
  ),
} satisfies Meta<typeof ColumnNode>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see a product column that names no alignment stack its children at its top start. */
export const Default: Story = {};

/** As a user, I see a product column spread its children over its height and align them to its end. */
export const SpreadToEnd: Story = {
  args: {
    value: { ...meta.args.value, props: { horizontalAlignment: 'End', verticalArrangement: 'SpaceBetween' } },
  },
};
