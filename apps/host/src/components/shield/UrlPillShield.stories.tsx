// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { trustedInput } from '@config/storybook/play';
import { byId } from '@dotli/ui/testing';
import type { ProductCardView } from '../../state/productCardView.js';
import { TopbarFrame } from '../../testing/stories/topbarFrame.js';
import { noProductPill, productPill, setShield, storyShield } from '../../testing/stories/shieldFixtures.js';
import { UrlPillShield } from './UrlPillShield.js';

// The card's tooltip is a top layer outside the story's canvas.
const body = within(document.body);

const SWAP: ProductCardView = {
  name: 'Swap',
  domain: 'swap.dot',
  description: 'Trade tokens across Polkadot chains from your browser, with no server in between.',
  icon: null,
  author: { status: 'idle' },
  connection: 'verified',
};

const [card, setCard] = createSignal<ProductCardView | null>(null);
let cardShows = 0;

function countCardShow(): void {
  cardShows += 1;
}

function getShield(): HTMLElement | null {
  return document.getElementById('verification-shield');
}

function getCardTooltip(): HTMLElement | null {
  return document.getElementById('product-card-tooltip');
}

const meta = {
  title: 'Host/Shield/UrlPillShield',
  component: UrlPillShield,
  parameters: { chrome: true, docs: { story: { inline: false, height: '120px' } } },
  tags: ['!autodocs'],
  args: { shield: storyShield, card, onCardShow: countCardShow },
  beforeEach: () => {
    noProductPill();
    setCard(null);
    cardShows = 0;
  },
  // The page's pill, a native button as on the page, so a keyboard reaches it and presses it.
  render: () => (
    <TopbarFrame center>
      <button type="button" id="url-pill" style={{ display: 'flex', 'align-items': 'center', gap: 'var(--sp-1_5)' }}>
        <UrlPillShield shield={storyShield} card={card} onCardShow={countCardShow} />
        <span>swap.dot</span>
      </button>
    </TopbarFrame>
  ),
} satisfies Meta<typeof UrlPillShield>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a visitor of a product, the shield shows in the state the host set, from before or after it mounts. */
export const ProductShield: Story = {
  beforeEach: () => {
    productPill();
    setShield('verified');
  },
  play: async ({ step }) => {
    await step('Then the shield shows the state set before it mounted', async () => {
      await waitFor(() => expect(getShield()).toHaveAttribute('data-state', 'verified'));
    });
    await step('When the host marks the product trusted', () => {
      setShield('trusted');
    });
    await step('Then the shield follows', async () => {
      await waitFor(() => expect(getShield()).toHaveAttribute('data-state', 'trusted'));
    });
  },
};

/** As a developer on a localhost proxy, or before a product loads, there is no shield. */
export const NoShieldOnLocalhost: Story = {
  play: async ({ step }) => {
    await step('Then no shield shows on a pill with no product, as on a localhost proxy', async () => {
      await expect(getShield()).toBeNull();
    });
    await step('When a product loads', () => {
      productPill();
    });
    await step('Then the shield shows with no state yet', async () => {
      await waitFor(() => expect(getShield()).not.toBeNull());
      await expect(getShield()).not.toHaveAttribute('data-state');
    });
  },
};

/**
 * As a visitor of a rendered product, I rest the mouse on the URL pill and its product card opens and stays while I
 * move onto it.
 */
export const CardOnHover: Story = {
  beforeEach: () => {
    productPill();
    setShield('verified');
    setCard(SWAP);
  },
  play: async ({ step }) => {
    await step('Then no author is asked for before the card opens', async () => {
      await expect(cardShows).toBe(0);
    });
    await step('When the mouse rests on the URL pill', async () => {
      await (await trustedInput()).hover(byId('url-pill'));
    });
    await step('Then the product card opens with the product, asking for the author once', async () => {
      await waitFor(() => expect(getCardTooltip()).toHaveAttribute('data-open'));
      await waitFor(() => expect(body.getByTestId('product-card-name')).toHaveTextContent('Swap'));
      await expect(byId('url-pill')).toHaveAttribute('aria-describedby', 'product-card-tooltip');
      await expect(cardShows).toBe(1);
    });
    await step('When the mouse moves from the pill onto the card', async () => {
      await (await trustedInput()).hover(body.getByTestId('product-card-name'));
    });
    await step('Then the card stays open on the same opening', async () => {
      await expect(getCardTooltip()).toHaveAttribute('data-open');
      await expect(cardShows).toBe(1);
    });
  },
};

/** As a visitor of a product that has not rendered yet, I rest the mouse on the URL pill and no product card opens. */
export const NoCardBeforeRender: Story = {
  beforeEach: () => {
    productPill();
  },
  play: async ({ step }) => {
    await step('When the mouse rests on the URL pill', async () => {
      await (await trustedInput()).hover(byId('url-pill'));
    });
    await step('Then no product card is wired to the pill or opens', async () => {
      await expect(byId('url-pill')).not.toHaveAttribute('aria-describedby');
      await expect(getCardTooltip()).toBeNull();
      await expect(cardShows).toBe(0);
    });
  },
};
