// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { TopbarFrame, expectPhone, openSurface } from '../../../.storybook/shell-fixtures.js';
import { getActiveChainRoles } from '@dotli/config';
import { recordBestBlock, recordChainActivity } from '../../network-monitor.js';
import { resetAllStoresForTests } from '../../state/create-store.js';
import { setProductLoaded } from '../../state/product.js';
import { ChainsPopover } from './ChainsPopover.js';

const open = openSurface({ trigger: 'chains-button', surface: 'chains-popover' });

const meta = {
  title: 'Shell/Network',
  component: ChainsPopover,
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  beforeEach: () => {
    setProductLoaded('Example', 'example');
    return resetAllStoresForTests;
  },
  render: () => (
    <TopbarFrame>
      <ChainsPopover />
    </TopbarFrame>
  ),
} satisfies Meta<typeof ChainsPopover>;

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

export const OpenInUse: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    const [relay, hub] = getActiveChainRoles();
    for (const genesis of [relay?.genesis, hub?.genesis, `0x${'ab'.repeat(32)}`]) {
      if (genesis !== undefined) {
        recordChainActivity({ genesisHash: genesis, consumers: 1, status: 'connected', following: true });
        recordBestBlock(genesis, 100);
      }
    }
  },
  play: async ctx => {
    await open(ctx);
  },
};
