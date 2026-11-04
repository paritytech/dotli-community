// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect } from 'storybook/test';
import { parsePolkadotAccount } from '../../runtime/polkadotAccount.js';
import type { ProductCardView } from '../../state/productCardView.js';
import { ProductCard } from './ProductCard.js';

const ADDRESS = parsePolkadotAccount('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY');

const PUBLISHED: ProductCardView = {
  name: 'Swap',
  domain: 'swap.dot',
  description: 'Trade tokens across Polkadot chains from your browser, with no server in between.',
  icon: null,
  author: { status: 'ready', author: { address: ADDRESS, username: { name: 'alice.dot', kind: 'full' } } },
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
    await step('Then the card names the product, its author and its connection', async () => {
      await expect(canvas.getByTestId('product-card-name')).toHaveTextContent('Swap');
      await expect(canvas.getByTestId('product-card-domain')).toHaveTextContent('swap.dot');
      await expect(canvas.getByTestId('product-card-description')).toHaveTextContent(PUBLISHED.description ?? '');
      const author = canvas.getByTestId('product-card-author');
      await expect(author).toHaveTextContent('Author');
      await expect(canvas.getByTestId('product-card-author-name')).toHaveTextContent('alice.dot');
      await expect(canvas.getByTestId('product-card-author-address')).toHaveTextContent('5GrwvaEF...utQY');
      const connection = canvas.getByTestId('product-card-connection');
      await expect(connection).toHaveAttribute('data-state', 'verified');
      await expect(connection).toHaveTextContent('Secure connection');
    });
  },
};

/** As a visitor, I open the card of a product served by trusted providers and see that it is. */
export const Trusted: Story = {
  args: { card: { ...PUBLISHED, connection: 'trusted' } },
  play: async ({ canvas, step }) => {
    await step('Then the connection row reads a trusted connection', async () => {
      const connection = canvas.getByTestId('product-card-connection');
      await expect(connection).toHaveAttribute('data-state', 'trusted');
      await expect(connection).toHaveTextContent('Trusted connection');
    });
  },
};

/** As a visitor, I open the card of a product whose author has no username and see the author's address alone. */
export const NoUsername: Story = {
  args: { card: { ...PUBLISHED, author: { status: 'ready', author: { address: ADDRESS, username: null } } } },
  play: async ({ canvas, step }) => {
    await step('Then the author shows the address and no name', async () => {
      await expect(canvas.getByTestId('product-card-author-address')).toHaveTextContent('5GrwvaEF...utQY');
      await expect(canvas.queryByTestId('product-card-author-name')).toBeNull();
    });
  },
};

/** As a visitor, I open the card before its author read starts and see no author section. */
export const AuthorIdle: Story = {
  args: { card: { ...PUBLISHED, author: { status: 'idle' } } },
  play: async ({ canvas, step }) => {
    await step('Then the card has no author section', async () => {
      await expect(canvas.getByTestId('product-card')).toBeVisible();
      await expect(canvas.queryByTestId('product-card-author')).toBeNull();
    });
  },
};

/** As a visitor, I open the card while its author still loads and see no author section. */
export const AuthorLoading: Story = {
  args: { card: { ...PUBLISHED, author: { status: 'loading' } } },
  play: async ({ canvas, step }) => {
    await step('Then the card has no author section', async () => {
      await expect(canvas.getByTestId('product-card')).toBeVisible();
      await expect(canvas.queryByTestId('product-card-author')).toBeNull();
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

/** As a visitor, I open the card of a product with no manifest and see its label beside the Polkadot mark. */
export const NoManifest: Story = {
  args: { card: { ...PUBLISHED, name: 'swap', description: null, icon: null } },
  play: async ({ canvas, step }) => {
    await step('Then the card shows the label, no description and the Polkadot mark as its icon', async () => {
      await expect(canvas.getByTestId('product-card-name')).toHaveTextContent('swap');
      await expect(canvas.queryByTestId('product-card-description')).toBeNull();
      await expect(canvas.getByTestId('product-card-mark')).toBeVisible();
      await expect(canvas.queryByTestId('product-card-icon')).toBeNull();
    });
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
  play: async ({ canvas, step }) => {
    await step('Then the icon slot shows the product icon instead of the Polkadot mark', async () => {
      await expect(canvas.getByTestId('product-card-icon')).toBeVisible();
      await expect(canvas.queryByTestId('product-card-mark')).toBeNull();
    });
  },
};

/** As a visitor, I open the card of a product with a long description and the card keeps to its surface. */
export const LongDescription: Story = {
  args: { card: { ...PUBLISHED, description: LONG_DESCRIPTION } },
  play: async ({ canvas, step }) => {
    await step('Then the description wraps and the card is no wider than its surface', async () => {
      const surface = canvas.getByTestId('product-card-surface');
      const card = canvas.getByTestId('product-card');
      await expect(canvas.getByTestId('product-card-description')).toHaveTextContent(LONG_DESCRIPTION);
      await expect(card.getBoundingClientRect().width).toBeLessThanOrEqual(surface.getBoundingClientRect().width);
      await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    });
  },
};

/** As a visitor, I open the card of a product with a long name and the card keeps to its surface. */
export const LongName: Story = {
  args: { card: { ...PUBLISHED, name: LONG_NAME } },
  play: async ({ canvas, step }) => {
    await step('Then the name ellipsizes and the card is no wider than its surface', async () => {
      const surface = canvas.getByTestId('product-card-surface');
      const card = canvas.getByTestId('product-card');
      const name = canvas.getByTestId('product-card-name');
      await expect(name).toHaveTextContent(LONG_NAME);
      await expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
      await expect(card.getBoundingClientRect().width).toBeLessThanOrEqual(surface.getBoundingClientRect().width);
      await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    });
  },
};
