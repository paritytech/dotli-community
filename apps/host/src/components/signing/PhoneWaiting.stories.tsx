// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { resetAllStoresForTests } from '@dotli/shared/testing';
import { Overlays, openModal, type ModalView } from '@dotli/ui';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { SignIcon } from '../icons/SignIcon.js';
import { phoneWaitingView, type PhoneAsk } from './phone-waiting-view.js';

const SIGN_LEAD = 'Open Polkadot App on your phone, then tap Sign or Reject';
const APPROVE_LEAD = 'Open Polkadot App on your phone, then Approve or Reject';

/** The ask the story's dialog is opened with. */
let current: { ask: PhoneAsk; title: string } = { ask: 'sign', title: 'Sign Transaction' };

const open = (ask: PhoneAsk, title: string) => (): (() => void) => {
  resetAllStoresForTests();
  current = { ask, title };
  return resetAllStoresForTests;
};

const meta = {
  title: 'Host/Signing/PhoneWaiting',
  // Own docs iframes, since each fixed dialog takes the focus and keys of the page it is on.
  parameters: { chrome: true, docs: { story: { inline: false, height: '640px' } } },
  beforeEach: open('sign', 'Sign Transaction'),
  render: () => {
    const view: ModalView<string> = phoneWaitingView({ ...current, icon: SignIcon });
    // The step is open before anyone answers it, since nothing here settles it.
    void openModal(view);
    return <Overlays />;
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// The dialog is portalled into the body, outside the story's canvas.
const body = within(document.body);

const assertWaiting = async (lead: string): Promise<void> => {
  await expect(await body.findByTestId('phone-waiting-lead')).toHaveTextContent(lead);
  await expect(body.getByTestId('phone-waiting-status')).toHaveTextContent('Waiting for your phone');
  await expect(body.getByTestId('phone-waiting')).toHaveTextContent('Polkadot App');
  await waitFor(() => expect(body.getByRole('button', { name: 'Wait in background' })).toBeVisible());
};

/** As a user signing, I am told to open Polkadot App and tap Sign or Reject while the request waits. */
export const Signing: Story = {
  play: async ({ step }) => {
    await step('Then the step names the phone and offers to wait in the background', () => assertWaiting(SIGN_LEAD));
  },
};

/** As a user granting an allowance, I am told to open Polkadot App and Approve or Reject. */
export const Approving: Story = {
  beforeEach: open('approve', 'Allowance'),
  play: async ({ step }) => {
    await step('Then the step names the phone and offers to wait in the background', () => assertWaiting(APPROVE_LEAD));
  },
};

/** As a phone user, I see the step as a sheet that has no close button, only Wait in background. */
export const Phone: Story = {
  // A docs iframe renders at the column's width, never the phone's.
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ step }) => {
    await step('Then the sheet leads with the title and has no close button', async () => {
      const head = await body.findByTestId('prompt-dialog-sheet-head');
      await expect(within(head).getByTestId('prompt-dialog-sheet-title')).toHaveTextContent('Sign Transaction');
      await expect(body.queryByTestId('prompt-dialog-sheet-close')).toBeNull();
    });
    await step('And the step still names the phone and offers to wait in the background', () =>
      assertWaiting(SIGN_LEAD),
    );
  },
};
