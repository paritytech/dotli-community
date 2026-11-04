// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { byId } from '@dotli/ui/testing';
import type { ProductCardView } from '../../state/productCardView.js';
import { expectPhone, openSurface, TopbarFrame } from '../../testing/stories/topbarFrame.js';
import { ProductButton } from './ProductButton.js';

// The sheet is a top layer outside the story's canvas.
const body = within(document.body);

const HOME_URL = 'https://dot.li/';

// Inline, so the story loads no image from the network.
const ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#e6007a"/></svg>',
  );

const SWAP: ProductCardView = {
  name: 'Swap',
  domain: 'swap.dot',
  description: 'Trade tokens across Polkadot chains from your browser, with no server in between.',
  icon: ICON,
  author: { status: 'idle' },
  connection: 'verified',
};

const [card, setCard] = createSignal<ProductCardView | null>(null);
let cardShows = 0;

function countCardShow(): void {
  cardShows += 1;
}

const open = openSurface({ trigger: 'product-button', surface: 'product-sheet' });
function getButton(): HTMLElement {
  return byId('product-button');
}

const meta = {
  title: 'Host/ProductCard/ProductButton',
  component: ProductButton,
  parameters: { chrome: true, docs: { story: { inline: false, height: '480px' } } },
  globals: { viewport: { value: 'phone', isRotated: false } },
  tags: ['!autodocs'],
  args: { card, onCardShow: countCardShow, homeUrl: HOME_URL },
  beforeEach: () => {
    setCard(null);
    cardShows = 0;
  },
  render: () => (
    <TopbarFrame>
      <ProductButton card={card} onCardShow={countCardShow} homeUrl={HOME_URL} />
    </TopbarFrame>
  ),
} satisfies Meta<typeof ProductButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * As a phone visitor of a product with an icon, I see its icon in the bar, and a tap opens its product card as a sheet
 * that ends with a link home.
 */
export const WithIcon: Story = {
  beforeEach: () => {
    setCard(SWAP);
  },
  play: async ctx => {
    await expectPhone(ctx.step);
    await ctx.step('Given the button shows the product icon and is named for the product', async () => {
      await expect(getButton().querySelector('[data-testid="product-button-icon"]')).not.toBeNull();
      await expect(getButton()).toHaveAttribute('aria-label', 'About swap.dot');
    });
    await ctx.step('Then no author is asked for before the sheet opens', async () => {
      await expect(cardShows).toBe(0);
    });
    await open(ctx);
    await ctx.step(
      'Then a sheet titled for the product shows its card and a link home, asking for the author once',
      async () => {
        await expect(body.getByTestId('popover-sheet-title')).toHaveTextContent('swap.dot');
        await waitFor(() => expect(body.getByTestId('product-card-name')).toHaveTextContent('Swap'));
        await expect(body.getByRole('link', { name: 'Open Polkadot' })).toHaveAttribute('href', HOME_URL);
        await expect(cardShows).toBe(1);
      },
    );
  },
};

/** As a phone visitor of a product with no icon, I see the Polkadot mark in the bar. */
export const WithoutIcon: Story = {
  beforeEach: () => {
    setCard({ ...SWAP, icon: null });
  },
  play: async ctx => {
    await expectPhone(ctx.step);
    await ctx.step('Then the button holds the Polkadot mark and no image', async () => {
      // The mark is an SVG element, which the HTML element queries reject.
      await expect(getButton().querySelector('[data-testid="product-button-mark"]')).not.toBeNull();
      await expect(getButton().querySelector('[data-testid="product-button-icon"]')).toBeNull();
    });
  },
};

/**
 * As a phone visitor with no product card to show, I see the Polkadot mark in the bar, and a tap opens a sheet with
 * only the link home.
 */
export const NoProduct: Story = {
  play: async ctx => {
    await expectPhone(ctx.step);
    await ctx.step('Given the button holds the Polkadot mark and is named for dot.li', async () => {
      // The mark is an SVG element, which the HTML element queries reject.
      await expect(getButton().querySelector('[data-testid="product-button-mark"]')).not.toBeNull();
      await expect(getButton()).toHaveAttribute('aria-label', 'dot.li');
    });
    await open(ctx);
    await ctx.step('Then the sheet holds no product card, only the link home', async () => {
      await expect(body.getByTestId('popover-sheet-title')).toHaveTextContent('dot.li');
      await expect(body.queryByTestId('product-card')).toBeNull();
      await expect(body.getByRole('link', { name: 'Open Polkadot' })).toHaveAttribute('href', HOME_URL);
      await expect(cardShows).toBe(0);
    });
  },
};
