// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { TopbarFrame, expectPhone, openSurface } from '../../../../.storybook/shell-fixtures.js';
import { resetAllStoresForTests } from '../../../state/create-store.js';
import { setProductLoaded } from '../../../state/product.js';
import { recordChainsButtonVisible } from '../../../state/topbar.js';
import { initSettingsStore } from '../../../state/settings.js';
import { ChainsPopover } from '../ChainsPopover.js';
import { PermissionsPopover } from '../PermissionsPopover.js';
import { SettingsPopover } from '../SettingsPopover.js';
import { OverflowMenu } from './OverflowMenu.js';

const open = openSurface({ trigger: 'more-button', surface: 'more-popover' });

const meta = {
  title: 'Shell/More',
  component: OverflowMenu,
  // The bar's own group builds the rows and the button ref; the render below ignores these.
  args: { rows: [], buttonRef: () => undefined },
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  beforeEach: () => {
    recordChainsButtonVisible(true);
    setProductLoaded('Example', 'example');
    initSettingsStore();
    return resetAllStoresForTests;
  },
  render: () => (
    <TopbarFrame room={40}>
      <ChainsPopover />
      <PermissionsPopover />
      <SettingsPopover />
    </TopbarFrame>
  ),
} satisfies Meta<typeof OverflowMenu>;

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
