// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Arrangement, HorizontalAlignment } from '@parity/truapi';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { dot, frame, Gallery } from '../../../testing/stories/rendererFixtures.js';
import { BoxNode } from './BoxNode.js';
import { ColumnNode } from './ColumnNode.js';

const ALIGNMENTS: { horizontal: HorizontalAlignment; vertical: Arrangement }[] = [
  { horizontal: 'Start', vertical: 'Start' },
  { horizontal: 'Center', vertical: 'Center' },
  { horizontal: 'End', vertical: 'SpaceBetween' },
];

const meta = {
  title: 'Entities/Chat/Renderer/ColumnNode',
  component: ColumnNode,
  parameters: { chrome: true },
  args: { value: { modifiers: frame(120), props: {} } },
} satisfies Meta<typeof ColumnNode>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see a product column place its children by its alignment and arrangement. */
export const Alignments: Story = {
  render: () => (
    <Gallery
      columns={3}
      items={ALIGNMENTS.map(({ horizontal, vertical }) => ({
        caption: `${horizontal}, ${vertical}`,
        node: (
          <ColumnNode
            value={{ modifiers: frame(120), props: { horizontalAlignment: horizontal, verticalArrangement: vertical } }}
          >
            <BoxNode value={dot()} />
            <BoxNode value={dot(40)} />
            <BoxNode value={dot()} />
          </ColumnNode>
        ),
      }))}
    />
  ),
};
