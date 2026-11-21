// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect } from 'storybook/test';
import { byId } from '@dotli/ui/testing';
import {
  bars,
  chain,
  given,
  resetStoryNetwork,
  storyNetwork,
  VERDICTS,
} from '../../testing/stories/networkFixtures.js';
import { openSurface, TopbarFrame } from '../../testing/stories/topbarFrame.js';
import { NetworkItem } from './NetworkItem.js';

/** The item as the page gives it its network. */
function StoryItem(): JSX.Element {
  return <NetworkItem {...storyNetwork} />;
}

const meta = {
  title: 'Host/Network/NetworkItem',
  component: StoryItem,
  parameters: { chrome: true, docs: { story: { inline: false, height: '240px' } } },
  beforeEach: () => {
    resetStoryNetwork();
  },
  render: () => (
    <TopbarFrame>
      <StoryItem />
    </TopbarFrame>
  ),
} satisfies Meta<typeof StoryItem>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a visitor on a good connection, the network button wears its health and opens the network panel. */
export const OpensBody: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    given([chain({ bars: bars(8, 3), sinceLast: 500, peers: 12 })], undefined, VERDICTS.good);
  },
  play: async ctx => {
    await ctx.step('Given the button badged with the good health', async () => {
      await expect(byId('chains-button')).toHaveAttribute('data-tone', 'ok');
    });
    await openSurface({ trigger: 'chains-button', surface: 'chains-popover' })(ctx);
  },
};
