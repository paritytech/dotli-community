// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { inTreeFrame } from '../../../testing/stories/rendererFixtures.js';
import { TextNode } from './TextNode.js';

const meta = {
  title: 'Entities/Chat/Renderer/TextNode',
  component: TextNode,
  parameters: { chrome: true },
  args: { value: { modifiers: [], props: {} }, children: 'Pick a delivery time' },
  decorators: [inTreeFrame],
} satisfies Meta<typeof TextNode>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see product text that names no style in the message's own type. */
export const Default: Story = {};

/** As a user, I see product text in the typography style and colour token the product names. */
export const Styled: Story = {
  args: { value: { modifiers: [], props: { style: 'HeadlineLarge', color: 'FgSuccess' } } },
};

/** As a user, I see a product's long word wrap inside the message rather than run past it. */
export const LongWordWraps: Story = {
  args: { children: 'Reference 5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY' },
};
