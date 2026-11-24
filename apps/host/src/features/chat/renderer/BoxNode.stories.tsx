// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { dot, frame, inTreeFrame } from '../../../testing/stories/rendererFixtures.js';
import { BoxCell, BoxNode } from './BoxNode.js';

const meta = {
  title: 'Entities/Chat/Renderer/BoxNode',
  component: BoxNode,
  parameters: { chrome: true },
  args: { value: { modifiers: frame(64), props: { contentAlignment: 'Center' } } },
  decorators: [inTreeFrame],
  render: args => (
    <BoxNode {...args}>
      <BoxCell>
        <BoxNode value={dot()} />
      </BoxCell>
    </BoxNode>
  ),
} satisfies Meta<typeof BoxNode>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see a product box place its content at its alignment, on its rounded background. */
export const Default: Story = {};

/** As a user, I see a product box with a circle background clip what it holds to the circle. */
export const Circle: Story = {
  args: {
    value: {
      modifiers: [
        { tag: 'Width', value: 72 },
        { tag: 'Height', value: 72 },
        { tag: 'Background', value: { color: 'BgSurfaceNested', shape: { tag: 'Circle' } } },
      ],
      props: { contentAlignment: 'TopStart' },
    },
  },
};

/** As a user, I see a product box drawn with a border over its background. */
export const Bordered: Story = {
  args: {
    value: {
      ...meta.args.value,
      modifiers: [
        ...meta.args.value.modifiers,
        { tag: 'Border', value: { width: 2, color: 'FgWarning', shape: { tag: 'Rounded', value: 12 } } },
      ],
    },
  },
};

/** As a user, I see a product box overlay its children in one cell, a badge over a tile. */
export const OverlaidChildren: Story = {
  args: { value: { ...meta.args.value, props: { contentAlignment: 'TopEnd' } } },
  render: args => (
    <BoxNode {...args}>
      <BoxCell>
        <BoxNode value={dot(48, 48)} />
      </BoxCell>
      <BoxCell>
        <BoxNode
          value={{
            modifiers: [
              { tag: 'Width', value: 16 },
              { tag: 'Height', value: 16 },
              { tag: 'Background', value: { color: 'FgError', shape: { tag: 'Circle' } } },
            ],
            props: {},
          }}
        />
      </BoxCell>
    </BoxNode>
  ),
};

/** As a user, I see a child that fills the box's width span it, though the box aligns its content to the start. */
export const FillingChild: Story = {
  args: { value: { ...meta.args.value, props: { contentAlignment: 'TopStart' } } },
  render: args => (
    <BoxNode {...args}>
      <BoxCell>
        <BoxNode
          value={{
            modifiers: [
              { tag: 'FillWidth', value: true },
              { tag: 'Height', value: 24 },
              { tag: 'Background', value: { color: 'BgSurfaceNested', shape: { tag: 'Rounded', value: 6 } } },
            ],
            props: {},
          }}
        />
      </BoxCell>
    </BoxNode>
  ),
};
