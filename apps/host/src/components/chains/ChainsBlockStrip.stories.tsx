// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor } from 'storybook/test';
import { openSurface, TopbarFrame } from '../../testing/stories/topbarFrame.js';
import {
  chain,
  given,
  resetStoryNetwork,
  setProductLoaded,
  storyNetwork,
} from '../../testing/stories/networkFixtures.js';
import { byTestId } from '@dotli/ui/testing';
import type { ChainView } from './chains.js';
import { NetworkItem } from './NetworkItem.js';

const open = openSurface({ trigger: 'chains-button', surface: 'chains-popover' });

/** The network button and panel as the host composes them, reading the story's network. */
function StoryChains(): JSX.Element {
  return <NetworkItem {...storyNetwork} />;
}

const meta = {
  title: 'Host/Network/Block strip',
  component: StoryChains,
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  beforeEach: () => {
    resetStoryNetwork();
    setProductLoaded(true);
  },
  render: () => (
    <TopbarFrame>
      <StoryChains />
    </TopbarFrame>
  ),
} satisfies Meta<typeof StoryChains>;

export default meta;
type Story = StoryObj<typeof meta>;

// The block strip of one chain, driven by hand: the relay is held and each play lands its blocks.

let relay: ChainView;

function holdRelay(): void {
  relay = chain();
  given([relay]);
}

/** The relay's first block, which only anchors the chain, as the page's monitor draws no bar for it. */
function anchor(block: number): void {
  relay = chain({ ...relay, latest: block, sinceLast: 0, state: 'live' });
  given([relay]);
}

/** Lands blocks `from` to `to` on the relay, each after the strip has drawn the one before. */
async function land(from: number, to = from): Promise<void> {
  for (let n = from; n <= to; n += 1) {
    // Bars already drawn keep their objects, as the page's monitor never changes a bar.
    relay = chain({
      ...relay,
      latest: n,
      sinceLast: 0,
      bars: [...relay.bars, { number: n, health: 'onTime', gapMs: 6000 }],
    });
    given([relay]);
    await waitFor(() => expect(document.querySelector(`[data-block="${String(n)}"]`)).not.toBeNull());
  }
}

function strip(): HTMLElement {
  return byTestId('chains-bars');
}

/**
 * As a user watching a chain, I see the strip glide left as a new block lands, and the new bar drop its landing mark
 * once its animation ends.
 */
export const LandingMarkDrops: Story = {
  tags: ['!autodocs'],
  beforeEach: holdRelay,
  play: async ctx => {
    await open(ctx);
    await ctx.step('As a user watching a chain, the strip glides left as a new block lands', async () => {
      // Given
      anchor(100);
      await land(101, 102);

      // When
      await land(103);

      // Then
      await expect(strip()).toHaveAttribute('data-sliding');
      await expect(strip().querySelector('[data-block="103"]')).toHaveAttribute('data-new');
    });
    await ctx.step('Then the new bar drops its landing mark once its animation ends', async () => {
      const newest = strip().querySelector('[data-block="103"]');
      await waitFor(() => expect(newest).not.toHaveAttribute('data-new'), { timeout: 3000 });
    });
  },
};
