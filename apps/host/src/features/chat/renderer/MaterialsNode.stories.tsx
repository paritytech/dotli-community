// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, within } from 'storybook/test';
import { TreeFrame } from '../../../testing/stories/rendererFixtures.js';
import { ColumnNode } from './ColumnNode.js';
import { MaterialsNode } from './MaterialsNode.js';
import { TextNode } from './TextNode.js';

const meta = {
  title: 'Entities/Chat/Renderer/MaterialsNode',
  component: MaterialsNode,
  parameters: { chrome: true },
  render: () => (
    <TreeFrame>
      <MaterialsNode>
        <ColumnNode
          value={{
            modifiers: [
              { tag: 'Padding', value: { top: 12, end: 12 } },
              { tag: 'Background', value: { color: 'BgSurfaceContainer', shape: { tag: 'Rounded', value: 12 } } },
            ],
            props: {},
          }}
        >
          <TextNode value={{ modifiers: [], props: { style: 'BodyLargeRegular' } }}>Gift card</TextNode>
          <TextNode value={{ modifiers: [], props: { style: 'BodyMediumRegular', color: 'FgSecondary' } }}>
            $25.00
          </TextNode>
        </ColumnNode>
      </MaterialsNode>
    </TreeFrame>
  ),
} satisfies Meta<typeof MaterialsNode>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see a materials node draw its children as they are, without its layers. */
export const DrawsChildren: Story = {
  play: async ({ canvas, step }) => {
    await step('Then its children draw inside it', async () => {
      const materials = within(canvas.getByTestId('chat-custom-materials'));
      await expect(materials.getByTestId('chat-custom-column')).toBeVisible();
    });
  },
};
