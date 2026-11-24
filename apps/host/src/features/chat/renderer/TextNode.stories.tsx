// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ColorToken, TypographyStyle } from '@parity/truapi';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { Gallery, TreeFrame } from '../../../testing/stories/rendererFixtures.js';
import { TextNode } from './TextNode.js';

const TYPOGRAPHY: { style: TypographyStyle; text: string }[] = [
  { style: 'HeadlineLarge', text: '$42.00' },
  { style: 'TitleMediumRegular', text: 'Order total' },
  { style: 'BodyLargeRegular', text: 'Pick a delivery time' },
  { style: 'BodyMediumRegular', text: 'Prep starts at 4:45 PM' },
  { style: 'BodySmallRegular', text: 'Prices include tax' },
];

const TEXT_COLOURS: ColorToken[] = ['FgPrimary', 'FgSecondary', 'FgTertiary', 'FgSuccess', 'FgWarning', 'FgError'];

const meta = {
  title: 'Entities/Chat/Renderer/TextNode',
  component: TextNode,
  parameters: { chrome: true },
  args: { value: { modifiers: [], props: {} }, children: 'Pick a delivery time' },
  render: args => (
    <TreeFrame>
      <TextNode {...args} />
    </TreeFrame>
  ),
} satisfies Meta<typeof TextNode>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see product text in each typography style, and in the message's own type when it names none. */
export const Typography: Story = {
  render: () => (
    <Gallery
      columns={1}
      items={[
        ...TYPOGRAPHY.map(({ style, text }) => ({
          caption: style,
          node: <TextNode value={{ modifiers: [], props: { style } }}>{text}</TextNode>,
        })),
        { caption: 'No style', node: <TextNode value={{ modifiers: [], props: {} }}>Pick a delivery time</TextNode> },
      ]}
    />
  ),
};

/** As a user, I see product text in each colour token. */
export const Colours: Story = {
  render: () => (
    <Gallery
      columns={3}
      items={TEXT_COLOURS.map(color => ({
        caption: color,
        node: <TextNode value={{ modifiers: [], props: { color } }}>{color}</TextNode>,
      }))}
    />
  ),
};

/** As a user, I see a product's long word wrap inside the message rather than run past it. */
export const LongWordWraps: Story = {
  args: { children: 'Reference 5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY' },
};
