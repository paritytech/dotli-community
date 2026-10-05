// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { SectionLabel } from './SectionLabel.js';

const meta = {
  title: 'Primitives/SectionLabel',
  parameters: { chrome: true },
  component: SectionLabel,
  args: { text: 'Account and chain' },
} satisfies Meta<typeof SectionLabel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Div: Story = {};
export const Heading: Story = { args: { as: 'h3' } };
