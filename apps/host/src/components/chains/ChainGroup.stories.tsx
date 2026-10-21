// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect } from 'storybook/test';
import type { ChainBar, ChainSummary } from './chain.js';
import { ChainGroup } from './ChainGroup.js';

/** `count` blocks from `from`, each on time. */
function onTime(from: number, count: number): ChainBar[] {
  return Array.from({ length: count }, (_, i) => ({ number: from + i, health: 'onTime' as const, gapMs: 6000 }));
}

const RELAY: ChainSummary = {
  label: 'Polkadot',
  state: 'live',
  blockTimeMs: 6000,
  bars: onTime(100, 3),
  reachable: true,
  phase: null,
  peers: 4,
};

const meta = {
  title: 'Entities/Chains/ChainGroup',
  component: ChainGroup,
  parameters: { chrome: true },
  args: { chain: RELAY, sinceLast: 0 },
  // On the popover's background, as the app shows it.
  render: args => (
    <div style={{ width: '320px', padding: '12px', background: 'var(--chrome-glass)' }}>
      <ChainGroup {...args} />
    </div>
  ),
} satisfies Meta<typeof ChainGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, a live chain shows its peers and one bar per recent block, each named with its delay. */
export const LiveChain: Story = {
  play: async ({ canvas, step }) => {
    await step('Then the peers chip and the block bars show', async () => {
      await expect(canvas.getByTestId('chains-group-peers')).toHaveTextContent('4 peers');
      await expect(canvas.getByRole('img', { name: 'Block 102, 6.0s, on time' })).toBeVisible();
    });
  },
};

/** As a user, a chain the app does not use says so instead of claiming a peer count. */
export const NotInUse: Story = {
  args: { chain: { ...RELAY, state: 'unused' } },
  play: async ({ canvas, step }) => {
    await step('Then it reads Not in use and shows no peers', async () => {
      await expect(canvas.getByTestId('chains-group-unused')).toHaveTextContent('Not in use');
      await expect(canvas.queryByTestId('chains-group-peers')).toBeNull();
    });
  },
};

/** As a user, a chain the network has no endpoint for says so in place of its blocks. */
export const NoEndpoint: Story = {
  args: { chain: { ...RELAY, reachable: false } },
  play: async ({ canvas, step }) => {
    await step('Then the cell says there is no endpoint', async () => {
      await expect(canvas.getByTestId('chains-cell')).toHaveTextContent('no endpoint on this network');
      await expect(canvas.queryByTestId('chains-bars')).toBeNull();
    });
  },
};

/** As a user waiting for a chain's first block, a ghost bar counts down to the next one. */
export const WaitingForFirstBlock: Story = {
  args: { chain: { ...RELAY, bars: [] }, sinceLast: 1500 },
  play: async ({ canvas, step }) => {
    await step('Then the ghost bar counts and the estimate shows', async () => {
      await expect(canvas.getByTestId('chains-bar-pending')).toHaveAttribute('data-pending', 'counting');
      await expect(canvas.getByTestId('chains-bars-waiting')).toHaveTextContent('next block in about 5s');
    });
  },
};

/** As a user, a chain with no peers yet raises its peers chip. */
export const NoPeers: Story = {
  args: { chain: { ...RELAY, peers: 0 } },
  play: async ({ canvas, step }) => {
    await step('Then the chip says 0 peers, is marked and is named for the chain', async () => {
      const chip = canvas.getByTestId('chains-group-peers');
      await expect(chip).toHaveTextContent('0 peers');
      await expect(chip).toHaveAttribute('data-tone', 'warn');
      await expect(chip).toHaveAccessibleName('Polkadot: 0 peers connected');
    });
  },
};
