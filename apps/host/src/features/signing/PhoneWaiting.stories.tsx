// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/* eslint-disable no-restricted-properties -- Predates the story contract: its plays still assert copy. */

import { resetAllStoresForTests } from '@dotli/shared/testing';
import { modals, Overlays, type ModalView } from '@dotli/ui';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, within } from 'storybook/test';
import type { PhoneAsk } from './phoneMethods.js';
import { phoneWaitingView } from './phoneWaitingView.js';

const SIGN_LEAD = 'Open Polkadot App on your phone, then tap Sign or Reject.';

const meta = {
  title: 'Host/Signing/PhoneWaiting',
  // Own docs iframes, since each fixed dialog takes the focus and keys of the page it is on.
  parameters: { chrome: true, docs: { story: { inline: false, height: '640px' } } },
  args: { ask: 'sign', title: 'Sign transaction' },
  beforeEach: () => {
    resetAllStoresForTests();
    return resetAllStoresForTests;
  },
  render: args => {
    // Only a signature carries the pen, as the reviews that hand off here do.
    const view: ModalView<string> = phoneWaitingView(args);
    // The step is open before anyone answers it, since nothing here settles it.
    void modals.open(view);
    return <Overlays />;
  },
} satisfies Meta<{ ask: PhoneAsk; title: string }>;

export default meta;
type Story = StoryObj<typeof meta>;

// The dialog is portalled into the body, outside the story's canvas.
const body = within(document.body);

async function assertAnnounced(lead: string): Promise<void> {
  const region = await body.findByRole('status');
  await expect(region).toHaveTextContent(lead);
  await expect(region).toHaveTextContent('Waiting for Polkadot App…');
  // The surface that takes focus is described by the step, so moving focus there reads it.
  const surface = body.getByTestId('prompt-dialog');
  await expect(surface).toHaveAccessibleDescription(expect.stringContaining(lead));
  await expect(surface).toHaveAccessibleDescription(expect.stringContaining('Waiting for Polkadot App…'));
}

/** As a user signing, I am told to open Polkadot App and tap Sign or Reject while the request waits. */
export const Signing: Story = {
  play: async ({ step }) => {
    await step('Then a screen reader hears the lead and the waiting line', () => assertAnnounced(SIGN_LEAD));
  },
};

/** As a user granting an allowance, I am told to open Polkadot App and tap Approve or Reject. */
export const Approving: Story = {
  args: { ask: 'approve', title: 'Approve an allowance' },
  play: async ({ step }) => {
    await step('Then a screen reader hears the lead and the waiting line', () =>
      assertAnnounced('Open Polkadot App on your phone, then tap Approve or Reject.'),
    );
  },
};

/** As a phone user, I see the step as a sheet that has no close button, only Wait in background. */
export const Phone: Story = {
  // A docs iframe renders at the column's width, never the phone's.
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
};
