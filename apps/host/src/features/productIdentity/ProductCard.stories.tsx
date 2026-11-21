// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect } from 'storybook/test';
import { parsePolkadotAccount } from '../../kit/polkadotAccount.js';
import type { ProductCardView } from './productCardView.js';
import { ProductCard } from './ProductCard.js';

const ADDRESS = parsePolkadotAccount('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY');

const PUBLISHED: ProductCardView = {
  name: 'Swap',
  domain: 'swap.dot',
  description: 'Trade tokens across Polkadot chains from your browser, with no server in between.',
  icon: null,
  author: { status: 'ready', author: { address: ADDRESS, name: { text: 'alice.dot', kind: 'full' } } },
  connection: 'verified',
};

const LONG_DESCRIPTION = Array.from(
  { length: 6 },
  () => 'Trade tokens across Polkadot chains from your browser, with no server in between, and keep your keys. ',
)
  .join('')
  .trim();

const LONG_NAME = 'A product whose name is far too long to fit on one line of the card, however wide the card is';

const meta = {
  title: 'Host/ProductCard/ProductCard',
  component: ProductCard,
  parameters: { chrome: true },
  args: { card: PUBLISHED },
  render: args => (
    <div data-testid="product-card-surface" style={{ width: 'var(--w-pop-md)' }}>
      <ProductCard {...args} />
    </div>
  ),
} satisfies Meta<typeof ProductCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a visitor, I open the card of a published product and see what it is, who made it and how it loaded. */
export const Published: Story = {
  play: async ({ canvas, step }) => {
    await step('Then the author shows the username alone, with no address', async () => {
      await expect(canvas.getByTestId('product-card-author-name')).toHaveTextContent('alice.dot');
      await expect(canvas.queryByTestId('product-card-author-address')).toBeNull();
    });
  },
};

/** As a visitor, I open the card while its author loads and see the author row wait with a spinner in place of the name. */
export const AuthorLoading: Story = {
  args: { card: { ...PUBLISHED, author: { status: 'loading' } } },
  play: async ({ canvas, step }) => {
    await step('Then the author row is busy, with the user glyph and a spinner in place of the name', async () => {
      await expect(canvas.getByTestId('product-card-author')).toHaveAttribute('aria-busy', 'true');
      await expect(canvas.getByTestId('product-card-author-spinner')).toBeVisible();
      await expect(canvas.getByTestId('product-card-author-avatar')).toHaveAttribute('data-anon');
    });
  },
};

/** As a visitor, I open the card of a product served by trusted providers and see that it is. */
export const Trusted: Story = {
  args: { card: { ...PUBLISHED, connection: 'trusted' } },
};

/** As a visitor, I open the card of a product whose author has a dotNS name and no username and see that name. */
export const DotnsName: Story = {
  args: {
    card: {
      ...PUBLISHED,
      author: { status: 'ready', author: { address: ADDRESS, name: { text: 'swap-labs.dot', kind: 'dotns' } } },
    },
  },
  play: async ({ canvas, step }) => {
    await step('Then the author shows the dotNS name beside the user glyph, not initials', async () => {
      await expect(canvas.getByTestId('product-card-author-name')).toHaveTextContent('swap-labs.dot');
      await expect(canvas.getByTestId('product-card-author-avatar')).toHaveAttribute('data-anon');
    });
  },
};

/** As a visitor, I open the card of a product whose author has no username or dotNS name and see the address alone. */
export const NoUsername: Story = {
  args: { card: { ...PUBLISHED, author: { status: 'ready', author: { address: ADDRESS, name: null } } } },
  play: async ({ canvas, step }) => {
    await step('Then the author shows the address alone', async () => {
      await expect(canvas.getByTestId('product-card-author-address')).toHaveTextContent('5GrwvaEF…utQY');
      await expect(canvas.queryByTestId('product-card-author-name')).toBeNull();
    });
  },
};

/** As a visitor, I open the card of a product with no owner in dotNS and see no author section. */
export const NoOwner: Story = {
  args: { card: { ...PUBLISHED, author: { status: 'ready', author: null } } },
  play: async ({ canvas, step }) => {
    await step('Then the card has no author section', async () => {
      await expect(canvas.getByTestId('product-card')).toBeVisible();
      await expect(canvas.queryByTestId('product-card-author')).toBeNull();
    });
  },
};

/** As a visitor, I open the card of a product with no manifest and see it named by its domain beside the Polkadot mark. */
export const NoManifest: Story = {
  args: { card: { ...PUBLISHED, name: PUBLISHED.domain, description: null, icon: null } },
  play: async ({ canvas, step }) => {
    await step(
      'Then the card is named by its domain once, with no description and the Polkadot mark as its icon',
      async () => {
        await expect(canvas.getByTestId('product-card-name')).toHaveTextContent(PUBLISHED.domain);
        await expect(canvas.queryByTestId('product-card-domain')).toBeNull();
        await expect(canvas.queryByTestId('product-card-description')).toBeNull();
        await expect(canvas.getByTestId('product-card-mark')).toBeVisible();
        await expect(canvas.queryByTestId('product-card-icon')).toBeNull();
      },
    );
  },
};

/** As a visitor, I open the card of a product with its own icon and see that icon. */
export const WithIcon: Story = {
  args: {
    card: {
      ...PUBLISHED,
      icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"%3E%3Crect width="1" height="1" fill="%23e6007a"/%3E%3C/svg%3E',
    },
  },
};

/** As a visitor, see the card of a product with a long description. */
export const LongDescription: Story = {
  args: { card: { ...PUBLISHED, description: LONG_DESCRIPTION } },
};

/** As a visitor, see the card of a product with a long name. */
export const LongName: Story = {
  args: { card: { ...PUBLISHED, name: LONG_NAME } },
};
