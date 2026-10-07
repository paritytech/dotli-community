// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { TopbarFrame, expectPhone, openSurface } from '../../../.storybook/shell-fixtures.js';
import { ThemeToggle } from './ThemeToggle.js';

const open = openSurface({ trigger: 'theme-toggle', surface: 'theme-popover' });

const meta = {
  title: 'Shell/Appearance',
  component: ThemeToggle,
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  render: () => (
    <TopbarFrame>
      <ThemeToggle />
    </TopbarFrame>
  ),
} satisfies Meta<typeof ThemeToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    await open(ctx);
  },
};

export const OpenPhone: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ctx => {
    await expectPhone(ctx.step);
    await open(ctx);
  },
};
