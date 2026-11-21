// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, within } from 'storybook/test';
import type { ChainBar } from './chain.js';
import type { ChainView } from './chains.js';
import type { ChainHealthFacts } from './chainHealth.js';
import { ChainRow } from './ChainRow.js';

/** `count` blocks from `from`, each on time. */
function onTime(from: number, count: number): ChainBar[] {
  return Array.from({ length: count }, (_, i) => ({ number: from + i, health: 'onTime' as const, gapMs: 6000 }));
}

// Twelve blocks of six seconds span the relay's one-minute window, so its share is measured.
const RELAY: ChainView = {
  key: 'relay',
  role: 'relay',
  label: 'Relay',
  state: 'live',
  blockTimeMs: 6000,
  bars: onTime(9_412_366, 12),
  sinceLast: 0,
  reachable: true,
  phase: null,
  syncShare: null,
  peers: 4,
};

const FACTS: ChainHealthFacts = { sinceRead: 0, behind: false, offline: false, unreachable: false };

const meta = {
  title: 'Entities/Chains/ChainRow',
  component: ChainRow,
  parameters: { chrome: true },
  args: { chain: RELAY, facts: FACTS },
  // On the popover's background, as the app shows it.
  render: args => (
    <div style={{ width: '296px', padding: '0 12px', background: 'var(--chrome-glass)' }}>
      <ChainRow {...args} />
    </div>
  ),
} satisfies Meta<typeof ChainRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, a live chain shows its healthy mark and how many of its blocks it produced. */
export const LiveChain: Story = {};

/**
 * As a user, I press a chain's row and its recent blocks open beneath it with its peers and newest block, and a second
 * press folds them away.
 */
export const OpensItsBlocks: Story = {
  play: async ({ canvas, userEvent, step }) => {
    const head = canvas.getByRole('button', { name: /Relay/ });
    await step('When I press the row', async () => {
      await userEvent.click(head);
    });
    await step('Then its blocks, peers and newest block show beneath it', async () => {
      await expect(head).toHaveAttribute('aria-expanded', 'true');
      await expect(canvas.getByTestId('chains-row-detail')).toHaveAttribute('id', head.getAttribute('aria-controls'));
      await expect(canvas.getAllByTestId('chains-bar')).toHaveLength(12);
      await expect(canvas.getByTestId('chains-row-peers')).toHaveTextContent('4 peers');
      await expect(canvas.getByTestId('chains-row-block')).toHaveTextContent('#9,412,377');
    });
    await step('When I press it again', async () => {
      await userEvent.click(head);
    });
    await step('Then the blocks fold away', async () => {
      await expect(head).toHaveAttribute('aria-expanded', 'false');
      await expect(canvas.queryByTestId('chains-row-detail')).toBeNull();
    });
  },
};

/** As a user, a chain the app does not use says so. */
export const NotInUse: Story = {
  args: { chain: { ...RELAY, state: 'unused' } },
};

/** As a user, I press a chain the network has no endpoint for and its strip draws none of its old blocks. */
export const NoEndpoint: Story = {
  args: { chain: { ...RELAY, reachable: false } },
  play: async ({ canvas, userEvent, step }) => {
    await step('When I press the row', async () => {
      await userEvent.click(canvas.getByRole('button', { name: /Relay/ }));
    });
    await step('Then its strip holds only empty slots', async () => {
      const strip = canvas.getByRole('group', { name: 'Relay: last 48 blocks, newest on the right' });
      await expect(within(strip).getAllByTestId('chains-bar-stub')).toHaveLength(48);
      await expect(canvas.queryAllByTestId('chains-bar')).toHaveLength(0);
    });
  },
};

/** As a user of a chain coming up again, such as after a pause, it reads Connecting over the bars it kept. */
export const ComingUpAgain: Story = {
  args: { chain: { ...RELAY, state: 'pending', sinceLast: null } },
};

/** As a user waiting for a live chain's first bar, its row reads Connected and its ghost bar grows toward the block. */
export const WaitingForFirstBlock: Story = {
  args: { chain: { ...RELAY, bars: [], sinceLast: 1500 } },
};

/** As a user, a chain the network verdict names as lagging says it is behind, in amber. */
export const Behind: Story = {
  args: {
    chain: {
      ...RELAY,
      bars: [
        ...onTime(100, 8),
        { number: 108, health: 'late', gapMs: 12_000 },
        { number: 109, health: 'veryLate', gapMs: 30_000 },
      ],
    },
    facts: { ...FACTS, behind: true },
  },
};
