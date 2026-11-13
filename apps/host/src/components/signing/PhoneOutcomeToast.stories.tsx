// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { resetAllStoresForTests } from '@dotli/shared/testing';
import { Overlays, showNotification } from '@dotli/ui';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import type { PhoneOutcome } from '../../runtime/phoneOutcome.js';
import { getPhoneOutcomeNotice } from '../../runtime/getPhoneOutcomeNotice.js';

type Args = { outcome: PhoneOutcome };

const meta = {
  title: 'Host/Signing/PhoneOutcomeToast',
  // Own docs iframes, so each stack is fixed in its own frame and fills its own store.
  parameters: { chrome: true, docs: { story: { inline: false, height: '320px' } } },
  beforeEach: () => {
    resetAllStoresForTests();
    return resetAllStoresForTests;
  },
  render: args => {
    const notice = getPhoneOutcomeNotice({ outcome: args.outcome, title: 'Sign Transaction', app: 'dotli.dot' });
    if (notice !== undefined) {
      showNotification(notice);
    }
    return <Overlays />;
  },
} satisfies Meta<Args>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I sign on my phone and one toast says the review was signed in Polkadot App. */
export const Signed: Story = {
  args: { outcome: { kind: 'ok', method: 'signPayload' } },
};

/** As a user, I share my accounts on my phone and one toast says they were shared. */
export const AccountsShared: Story = {
  args: { outcome: { kind: 'ok', method: 'getAccount' } },
};

/** As a user, I grant every allowance on my phone and one toast says it was granted. */
export const AllowanceGranted: Story = {
  args: { outcome: { kind: 'ok', method: 'requestResourceAllocation', allocations: ['Allocated'] } },
};

/** As a user, I grant some allowances on my phone and one toast says the allowance was partly granted. */
export const AllowancePartlyGranted: Story = {
  args: { outcome: { kind: 'ok', method: 'requestResourceAllocation', allocations: ['Allocated', 'Rejected'] } },
};

/** As a user, I approve an allowance that is not available and one toast says Polkadot App did not complete it. */
export const AllowanceNotAvailable: Story = {
  args: { outcome: { kind: 'ok', method: 'requestResourceAllocation', allocations: ['NotAvailable'] } },
};

/** As a user, I reject on my phone and one toast says it was rejected in Polkadot App. */
export const Rejected: Story = {
  args: { outcome: { kind: 'rejected' } },
};

/** As a user, the app stops waiting for my phone and one toast says so. */
export const Withdrawn: Story = {
  args: { outcome: { kind: 'withdrawn' } },
};

/** As a user, Polkadot App fails the request and one toast gives the reason. */
export const Failed: Story = {
  args: { outcome: { kind: 'failed', tag: 'HostFailure', reason: 'Phone went offline' } },
};
