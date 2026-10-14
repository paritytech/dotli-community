// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor } from 'storybook/test';
import { openSurface, TopbarFrame } from '../../testing/stories/topbar-frame.js';
import {
  chain,
  given,
  resetStoryNetwork,
  setProductLoaded,
  storyNetwork,
} from '../../testing/stories/network-fixtures.js';
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

/** A strip with bars. */
const stripStory = {
  tags: ['!autodocs'],
  beforeEach: holdRelay,
} satisfies Story;

function strip(): HTMLElement {
  return byTestId('chains-bars');
}

function shownBlocks(): string[] {
  return Array.from(strip().querySelectorAll<HTMLElement>('[data-block]'), bar => bar.dataset['block'] ?? '');
}

/** As a user watching a chain, I see the newest block at the right-hand end of the strip. */
export const NewestBlockAtRight: Story = {
  ...stripStory,
  play: async ctx => {
    await open(ctx);
    await ctx.step('As a user watching a chain, the newest block sits at the right-hand end', async () => {
      // When
      anchor(100);
      await land(101, 102);

      // Then
      await expect(shownBlocks()).toEqual(['101', '102']);
    });
  },
};

/** As a user watching a chain, I see a block already on screen keep its own bar when new ones arrive. */
export const BarKeepsIdentity: Story = {
  ...stripStory,
  play: async ctx => {
    await open(ctx);
    await ctx.step('As a user watching a chain, a block already on screen keeps its own bar', async () => {
      // Given
      anchor(100);
      await land(101, 102);
      const first = strip().querySelector('[data-block="101"]');

      // When
      await land(103);

      // Then
      await expect(strip().querySelector('[data-block="101"]')).toBe(first);
    });
  },
};

/** As a user watching a chain, I see the strip glide left as a new block appears. */
export const SlidesOnNewBlock: Story = {
  ...stripStory,
  play: async ctx => {
    await open(ctx);
    await ctx.step('As a user watching a chain, the strip glides left as the new block appears', async () => {
      // Given
      anchor(100);
      await land(101, 102);

      // When
      await land(103);

      // Then
      await expect(strip()).toHaveAttribute('data-sliding');
      await expect(strip().querySelector('[data-block="103"]')).toHaveAttribute('data-new');
    });
  },
};

/** As a user watching a chain, I see a new bar drop its landing mark once its animation ends. */
export const LandingMarkDrops: Story = {
  ...stripStory,
  play: async ctx => {
    await open(ctx);
    await ctx.step('As a user watching a chain, a new bar drops its landing mark once its animation ends', async () => {
      // Given
      anchor(100);
      await land(101, 102);
      await land(103);
      const newest = strip().querySelector('[data-block="103"]');
      await expect(newest).toHaveAttribute('data-new');

      // Then, once the landing animation has run
      await waitFor(() => expect(newest).not.toHaveAttribute('data-new'), { timeout: 3000 });
    });
  },
};

/** As a user opening the panel on a chain with history, I see nothing slide. */
export const NoSlideOnOpen: Story = {
  ...stripStory,
  play: async ctx => {
    await open(ctx);
    await ctx.step('As a user opening the panel on a chain with history, nothing slides', async () => {
      // When
      anchor(100);
      await land(101);

      // Then
      await expect(strip()).not.toHaveAttribute('data-sliding');
    });
  },
};

/** As a user watching a chain, I see the strip always hold 48 slots, with stubs filling the empty ones. */
export const FortyEightSlots: Story = {
  ...stripStory,
  play: async ctx => {
    await open(ctx);
    await ctx.step(
      'As a user watching a chain, the strip always has 48 slots and stubs fill the empty ones',
      async () => {
        // When
        anchor(100);
        await land(101, 105);

        // Then: five bars, as the first block only anchors the chain, and 43 stubs
        await expect(strip().children).toHaveLength(48);
        await expect(shownBlocks()).toHaveLength(5);
        await expect(strip().querySelectorAll('[data-testid="chains-bar-stub"]')).toHaveLength(43);
      },
    );
  },
};
