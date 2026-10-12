// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect } from 'storybook/test';
import {
  markLocalWalletResuming,
  pauseLocalWallet,
  resetWalletPauseForTests,
  type WalletPauseReason,
} from '../../state/wallet-pause.js';
import { WALLET_PAUSED_COPY, WalletPausedBanner } from './WalletPausedBanner.js';

const meta = {
  title: 'Primitives/WalletPausedBanner',
  component: WalletPausedBanner,
  // Own docs iframes, so each fixed banner sits in its own frame and store.
  parameters: { chrome: true, docs: { story: { inline: false, height: '120px' } } },
} satisfies Meta<typeof WalletPausedBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

const paused =
  (reason: WalletPauseReason, resuming = false) =>
  () => {
    resetWalletPauseForTests();
    pauseLocalWallet(reason);
    if (resuming) {
      markLocalWalletResuming();
    }
    return resetWalletPauseForTests;
  };

export const MovedToAnotherTab: Story = {
  beforeEach: paused('moved'),
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId('wallet-paused-banner')).toHaveTextContent(WALLET_PAUSED_COPY.moved.paused);
  },
};

export const ChangedInAnotherTab: Story = {
  beforeEach: paused('changed'),
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId('wallet-paused-banner')).toHaveTextContent(WALLET_PAUSED_COPY.changed.paused);
  },
};

export const Resuming: Story = {
  beforeEach: paused('moved', true),
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId('wallet-paused-banner')).toHaveTextContent(WALLET_PAUSED_COPY.moved.resuming);
  },
};
