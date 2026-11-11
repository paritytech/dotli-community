// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { resetAllStoresForTests } from '@dotli/shared/testing';
import { modals, Overlays, type ModalView } from '@dotli/ui';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import type { PhoneAsk } from '../../runtime/phoneMethods.js';
import { SignIcon } from '../icons/SignIcon.js';
import { phoneWaitingView } from './phoneWaitingView.js';

const SIGN_LEAD = 'Open Polkadot App on your phone, then tap Sign or Reject';

const meta = {
  title: 'Host/Signing/PhoneWaiting',
  // Own docs iframes, since each fixed dialog takes the focus and keys of the page it is on.
  parameters: { chrome: true, docs: { story: { inline: false, height: '640px' } } },
  args: { ask: 'sign', title: 'Sign Transaction' },
  beforeEach: () => {
    resetAllStoresForTests();
    return resetAllStoresForTests;
  },
  render: args => {
    const view: ModalView<string> = phoneWaitingView({ ...args, icon: SignIcon });
    // The step is open before anyone answers it, since nothing here settles it.
    void modals.open(view);
    return <Overlays />;
  },
} satisfies Meta<{ ask: PhoneAsk; title: string }>;

export default meta;
type Story = StoryObj<typeof meta>;

// The dialog is portalled into the body, outside the story's canvas.
const body = within(document.body);

async function assertWaiting(lead: string): Promise<void> {
  await expect(await body.findByTestId('phone-waiting-lead')).toHaveTextContent(lead);
  await expect(body.getByTestId('phone-waiting-status')).toHaveTextContent('Waiting for your phone');
  await expect(body.getByTestId('phone-waiting')).toHaveTextContent('Polkadot App');
  await waitFor(() => expect(body.getByRole('button', { name: 'Wait in background' })).toBeVisible());
}

/** The phone's own buttons, as the illustration labels them. */
function phoneButtons(): (string | null)[] {
  return ['phone-illustration-reject', 'phone-illustration-primary'].map(id => body.getByTestId(id).textContent);
}

async function assertAnnounced(lead: string): Promise<void> {
  const region = body.getByRole('status');
  await expect(region).toHaveTextContent(lead);
  await expect(region).toHaveTextContent('Waiting for your phone');
  // The surface that takes focus is described by the step, so moving focus there reads it.
  const surface = body.getByTestId('prompt-dialog');
  await expect(surface).toHaveAccessibleDescription(expect.stringContaining(lead));
  await expect(surface).toHaveAccessibleDescription(expect.stringContaining('Waiting for your phone'));
}

/** As a user signing, I am told to open Polkadot App and tap Sign or Reject while the request waits. */
export const Signing: Story = {
  play: async ({ step }) => {
    await step('Then the step names the phone and offers to wait in the background', () => assertWaiting(SIGN_LEAD));
    await step('And the phone drawn shows Reject and Sign', async () => {
      await expect(phoneButtons()).toEqual(['Reject', 'Sign']);
    });
    await step('And a screen reader hears the lead and the waiting line', () => assertAnnounced(SIGN_LEAD));
  },
};

/** As a user granting an allowance, I am told to open Polkadot App and Approve or Reject. */
export const Approving: Story = {
  args: { ask: 'approve', title: 'Allowance' },
};

/** As a phone user, I see the step as a sheet that has no close button, only Wait in background. */
export const Phone: Story = {
  // A docs iframe renders at the column's width, never the phone's.
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
};
