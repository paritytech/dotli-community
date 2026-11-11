// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { byTestId } from '@dotli/ui/testing';
import { PairingQr } from './PairingQr.js';

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
