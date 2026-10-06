// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { TopbarFrame, expectPhone, openSurface } from '../../../.storybook/shell-fixtures.js';
import { resetAllStoresForTests } from '../../state/create-store.js';
import { initSettingsStore } from '../../state/settings.js';
import { SettingsPopover } from './SettingsPopover.js';

const open = openSurface({ trigger: 'mode-button', surface: 'mode-popover' });

const meta = {
  title: 'Shell/Settings',
  component: SettingsPopover,
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  beforeEach: () => {
    initSettingsStore();
    return resetAllStoresForTests;
  },
  render: () => (
    <TopbarFrame>
      <SettingsPopover />
    </TopbarFrame>
  ),
} satisfies Meta<typeof SettingsPopover>;

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
