// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { frame, TreeFrame } from '../../../testing/stories/rendererFixtures.js';
import { RowNode } from './RowNode.js';
import { SpacerNode } from './SpacerNode.js';
import { TextNode } from './TextNode.js';

const meta = {
  title: 'Entities/Chat/Renderer/SpacerNode',
  component: SpacerNode,
  parameters: { chrome: true },
  args: { value: { modifiers: [] } },
  render: args => (
    <TreeFrame>
      <RowNode value={{ modifiers: frame(40), props: { verticalAlignment: 'Center' } }}>
        <TextNode value={{ modifiers: [], props: {} }}>Subtotal</TextNode>
        <SpacerNode {...args} />
        <TextNode value={{ modifiers: [], props: {} }}>$38.00</TextNode>
      </RowNode>
    </TreeFrame>
  ),
} satisfies Meta<typeof SpacerNode>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see a spacer in a product row push the text on either side of it apart. */
export const PushesApart: Story = {};
