// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { byTestId } from '@dotli/ui/testing';
import { PairingQr } from './PairingQr.js';
import { drawQrCode } from './qrCode.js';

/** The preload the view is given, which loads nothing and records the call. */
const prepareQr = fn<() => void>();

const meta = {
  title: 'Host/PairingQr',
  component: PairingQr,
  tags: ['!autodocs'],
  args: { payload: null, shown: true, link: false, prepareQr },
  beforeEach: () => {
    prepareQr.mockClear();
  },
} satisfies Meta<typeof PairingQr>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user who starts signing in, I see the spinner while the QR encoder starts loading. */
export const PreloadsWhilePreparing: Story = {
  play: async ({ step }) => {
    await step('Given the spinner in the code place', async () => {
      await waitFor(() => expect(byTestId('auth-modal-spinner')).toBeVisible());
    });
    await step('Then the code drawing started loading once', async () => {
      await waitFor(() => expect(prepareQr).toHaveBeenCalledTimes(1));
    });
  },
};

/** As a user who starts signing in, I see the code on its tile, with the badge at its centre, once it is drawn. */
export const Drawn: Story = {
  args: { payload: 'polkadotapp://pair?handshake=test', drawQr: drawQrCode },
  play: async ({ step }) => {
    await step('Then the code is on its tile with its badge', async () => {
      const tile = await waitFor(() => byTestId('auth-modal-qr-tile'));
      await expect(tile.querySelector('canvas')).toHaveAttribute(
        'data-qr-payload',
        'polkadotapp://pair?handshake=test',
      );
      await expect(byTestId('auth-modal-qr-badge', tile)).toBeInTheDocument();
    });
  },
};
