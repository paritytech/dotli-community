// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { resetAllStoresForTests } from '@dotli/shared/testing';
import { Overlays, showNotification, type NotificationParams } from '@dotli/ui';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import type { PhoneOutcome } from '../../runtime/phone-outcome.js';
import { phoneOutcomeNotice } from '../../runtime/phone-outcome-notice.js';

const APP = 'dotli.dot';

// The stack is portalled into the body, outside the story's canvas.
const body = within(document.body);

type Args = {
  outcome: PhoneOutcome;
  /** The toast's text, or undefined when the outcome shows none. */
  text: string | undefined;
  tone?: NonNullable<NotificationParams['tone']>;
};

const meta = {
  title: 'Host/Signing/PhoneOutcomeToast',
  // Own docs iframes, so each stack is fixed in its own frame and fills its own store.
  parameters: { chrome: true, docs: { story: { inline: false, height: '320px' } } },
  beforeEach: () => {
    resetAllStoresForTests();
    return resetAllStoresForTests;
  },
  render: () => <Overlays />,
  play: async ({ args, step }) => {
    let notice: NotificationParams | undefined;
    await step('When the waited request ends', () => {
      notice = phoneOutcomeNotice({ outcome: args.outcome, title: 'Sign Transaction', app: APP });
    });
    const { text, tone } = args;
    if (text === undefined) {
      await step('Then there is no toast to show', async () => {
        await expect(notice).toBeUndefined();
      });
      return;
    }
    await step('And its toast goes to the page', () => {
      if (notice === undefined) {
        throw new Error('the outcome gave no toast');
      }
      showNotification(notice);
    });
    await step('Then one toast shows the outcome, named for the app it came from', async () => {
      await waitFor(() => expect(body.getAllByTestId('notif-card')).toHaveLength(1));
      const card = within(body.getByTestId('notif-card'));
      await expect(card.getByTestId('notif-title')).toHaveTextContent(APP);
      await expect(card.getByTestId('notif-body')).toHaveTextContent(text);
      await expect(card.getByTestId('notif-icon')).toHaveAttribute('data-tone', tone);
    });
  },
} satisfies Meta<Args>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I sign on my phone and one toast says the review was signed in Polkadot App. */
export const Signed: Story = {
  args: {
    outcome: { kind: 'ok', method: 'signPayload' },
    text: 'Sign Transaction: signed in Polkadot App',
    tone: 'ok',
  },
};

/** As a user, I share my accounts on my phone and one toast says they were shared. */
export const AccountsShared: Story = {
  args: { outcome: { kind: 'ok', method: 'getAccount' }, text: 'Accounts shared', tone: 'ok' },
};

/** As a user, I grant every allowance on my phone and one toast says it was granted. */
export const AllowanceGranted: Story = {
  args: {
    outcome: { kind: 'ok', method: 'requestResourceAllocation', allocations: ['Allocated'] },
    text: 'Allowance granted',
    tone: 'ok',
  },
};

/** As a user, I grant some allowances on my phone and one toast says the allowance was partly granted. */
export const AllowancePartlyGranted: Story = {
  args: {
    outcome: { kind: 'ok', method: 'requestResourceAllocation', allocations: ['Allocated', 'Rejected'] },
    text: 'Allowance partly granted',
    tone: 'warn',
  },
};

/** As a user, I approve an allowance that is not available and one toast says Polkadot App did not complete it. */
export const AllowanceNotAvailable: Story = {
  args: {
    outcome: { kind: 'ok', method: 'requestResourceAllocation', allocations: ['NotAvailable'] },
    text: "Polkadot App didn't complete the request: allowance not available",
    tone: 'err',
  },
};

/** As a user, I reject on my phone and one toast says it was rejected in Polkadot App. */
export const Rejected: Story = {
  args: { outcome: { kind: 'rejected' }, text: 'Rejected in Polkadot App', tone: 'info' },
};

/** As a user, the app stops waiting for my phone and one toast says so. */
export const Withdrawn: Story = {
  args: { outcome: { kind: 'withdrawn' }, text: 'The app stopped waiting', tone: 'info' },
};

/** As a user, Polkadot App fails the request and one toast gives the reason. */
export const Failed: Story = {
  args: {
    outcome: { kind: 'failed', tag: 'HostFailure', reason: 'Phone went offline' },
    text: "Polkadot App didn't complete the request: Phone went offline",
    tone: 'err',
  },
};

/** As a user, my request went away with the page and there is no toast to show. */
export const Gone: Story = {
  args: { outcome: { kind: 'gone' }, text: undefined },
};
