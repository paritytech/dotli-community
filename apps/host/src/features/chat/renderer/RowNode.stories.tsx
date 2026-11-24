// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { dot, frame, Gallery } from '../../../testing/stories/rendererFixtures.js';
import { BoxNode } from './BoxNode.js';
import { RowNode } from './RowNode.js';

const meta = {
  title: 'Entities/Chat/Renderer/RowNode',
  component: RowNode,
  parameters: { chrome: true },
  args: { value: { modifiers: frame(48), props: {} } },
} satisfies Meta<typeof RowNode>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see a product row place its children by its arrangement and alignment. */
export const Arrangements: Story = {
  render: () => (
    <Gallery
      columns={1}
      items={[
        {
          caption: 'Start, Center',
          node: (
            <RowNode
              value={{ modifiers: frame(48), props: { horizontalArrangement: 'Start', verticalAlignment: 'Center' } }}
            >
              <BoxNode value={dot()} />
              <BoxNode value={dot()} />
              <BoxNode value={dot()} />
            </RowNode>
          ),
        },
        {
          caption: 'SpaceEvenly, Top',
          node: (
            <RowNode
              value={{
                modifiers: frame(48),
                props: { horizontalArrangement: 'SpaceEvenly', verticalAlignment: 'Top' },
              }}
            >
              <BoxNode value={dot()} />
              <BoxNode value={dot(24, 32)} />
              <BoxNode value={dot()} />
            </RowNode>
          ),
        },
      ]}
    />
  ),
};
