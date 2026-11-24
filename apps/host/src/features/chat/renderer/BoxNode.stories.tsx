// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ColorToken, ContentAlignment, Modifier } from '@parity/truapi';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { dot, frame, Gallery, TreeFrame } from '../../../testing/stories/rendererFixtures.js';
import { BoxCell, BoxNode } from './BoxNode.js';

const CONTENT_ALIGNMENTS: ContentAlignment[] = [
  'TopStart',
  'TopCenter',
  'TopEnd',
  'CenterStart',
  'Center',
  'CenterEnd',
  'BottomStart',
  'BottomCenter',
  'BottomEnd',
];

const SURFACE_COLOURS: ColorToken[] = ['BgSurfaceMain', 'BgSurfaceContainer', 'BgSurfaceNested'];

/** A 72 px tall box drawn by its modifiers alone. */
function tile(...modifiers: Modifier[]) {
  return <BoxNode value={{ modifiers: [{ tag: 'Height', value: 72 }, ...modifiers], props: {} }} />;
}

const meta = {
  title: 'Entities/Chat/Renderer/BoxNode',
  component: BoxNode,
  parameters: { chrome: true },
  args: { value: { modifiers: frame(64), props: { contentAlignment: 'Center' } } },
  render: args => (
    <TreeFrame>
      <BoxNode {...args}>
        <BoxCell>
          <BoxNode value={dot()} />
        </BoxCell>
      </BoxNode>
    </TreeFrame>
  ),
} satisfies Meta<typeof BoxNode>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see a product box place its content at each of its alignments. */
export const ContentAlignments: Story = {
  render: () => (
    <Gallery
      columns={3}
      items={CONTENT_ALIGNMENTS.map(contentAlignment => ({
        caption: contentAlignment,
        node: (
          <BoxNode value={{ modifiers: frame(64), props: { contentAlignment } }}>
            <BoxCell>
              <BoxNode value={dot()} />
            </BoxCell>
          </BoxNode>
        ),
      }))}
    />
  ),
};

/** As a user, I see a product box overlay its children in one cell, a badge over a tile. */
export const OverlaidChildren: Story = {
  render: () => (
    <TreeFrame>
      <BoxNode value={{ modifiers: frame(64), props: { contentAlignment: 'TopEnd' } }}>
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
    </TreeFrame>
  ),
};

/** As a user, I see product backgrounds and borders in each shape, a shaped background clipping what it holds. */
export const BackgroundsAndBorders: Story = {
  render: () => (
    <Gallery
      columns={3}
      items={[
        {
          caption: 'Rounded(12) Container',
          node: tile({
            tag: 'Background',
            value: { color: 'BgSurfaceContainer', shape: { tag: 'Rounded', value: 12 } },
          }),
        },
        {
          caption: 'Circle Nested',
          node: tile(
            { tag: 'Width', value: 72 },
            { tag: 'Background', value: { color: 'BgSurfaceNested', shape: { tag: 'Circle' } } },
          ),
        },
        {
          caption: 'Square Main',
          node: tile(
            { tag: 'Background', value: { color: 'BgSurfaceMain', shape: { tag: 'Square' } } },
            { tag: 'Border', value: { width: 1, color: 'FgTertiary', shape: { tag: 'Square' } } },
          ),
        },
        {
          caption: 'Border 1 Success',
          node: tile({ tag: 'Border', value: { width: 1, color: 'FgSuccess', shape: { tag: 'Rounded', value: 12 } } }),
        },
        {
          caption: 'Border 2 Warning',
          node: tile({ tag: 'Border', value: { width: 2, color: 'FgWarning', shape: { tag: 'Rounded', value: 12 } } }),
        },
        {
          caption: 'Border 1 Error and background',
          node: tile(
            { tag: 'Background', value: { color: 'BgSurfaceContainer', shape: { tag: 'Rounded', value: 12 } } },
            { tag: 'Border', value: { width: 1, color: 'FgError', shape: { tag: 'Rounded', value: 12 } } },
          ),
        },
      ]}
    />
  ),
};

/** As a user, I see each surface token a product paints a box with. */
export const SurfaceColours: Story = {
  render: () => (
    <Gallery
      columns={3}
      items={SURFACE_COLOURS.map(color => ({
        caption: color,
        node: tile(
          { tag: 'Border', value: { width: 1, color: 'FgTertiary', shape: { tag: 'Rounded', value: 8 } } },
          { tag: 'Background', value: { color, shape: { tag: 'Rounded', value: 8 } } },
        ),
      }))}
    />
  ),
};
