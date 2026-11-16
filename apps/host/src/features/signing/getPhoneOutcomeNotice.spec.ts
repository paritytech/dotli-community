// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { NotificationParams } from '@dotli/ui';
import { BanIcon, CircleAlertIcon, CircleCheckIcon, InfoIcon } from '@dotli/ui/icons';
import { describe, expect, it } from 'vitest';
import { getPhoneOutcomeNotice } from './getPhoneOutcomeNotice.js';
import type { PhoneOutcome } from './phoneOutcome.js';

const TITLE = 'Sign Transaction';
const APP = 'dotli.dot';

type NoticeCase = {
  story: string;
  outcome: PhoneOutcome;
  notice: NotificationParams | undefined;
};

const CASES: NoticeCase[] = [
  {
    story: 'As a user, I sign on my phone and see what the review signs confirmed in Polkadot App',
    outcome: { kind: 'ok', method: 'signPayload' },
    notice: { label: 'Transaction signed in Polkadot App', text: APP, tone: 'ok', icon: CircleCheckIcon },
  },
  {
    story: 'As a user, I sign a raw message on my phone and see the same confirmation',
    outcome: { kind: 'ok', method: 'signRawWithLegacyAccount' },
    notice: { label: 'Transaction signed in Polkadot App', text: APP, tone: 'ok', icon: CircleCheckIcon },
  },
  {
    story: 'As a user, I share my accounts and see that they were shared',
    outcome: { kind: 'ok', method: 'getAccount' },
    notice: { label: 'Accounts shared', text: APP, tone: 'ok', icon: CircleCheckIcon },
  },
  {
    story: 'As a user, I grant every allowance and see it granted',
    outcome: { kind: 'ok', method: 'requestResourceAllocation', allocations: ['Allocated', 'Allocated'] },
    notice: { label: 'Allowance granted', text: APP, tone: 'ok', icon: CircleCheckIcon },
  },
  {
    story: 'As a user, I grant some allowances and see the allowance partly granted, with how many',
    outcome: { kind: 'ok', method: 'requestResourceAllocation', allocations: ['Allocated', 'Rejected'] },
    notice: {
      label: 'Allowance partly granted',
      text: `${APP} · 1 of 2`,
      tone: 'warn',
      icon: CircleAlertIcon,
    },
  },
  {
    story: 'As a user, I reject every allowance and see the rejection in Polkadot App',
    outcome: { kind: 'ok', method: 'requestResourceAllocation', allocations: ['Rejected', 'Rejected'] },
    notice: { label: 'Rejected in Polkadot App', text: APP, tone: 'idle', icon: BanIcon },
  },
  {
    story: 'As a user, I approve an allowance that is not available and see that Polkadot App did not complete it',
    outcome: { kind: 'ok', method: 'requestResourceAllocation', allocations: ['Rejected', 'NotAvailable'] },
    notice: {
      label: 'Not completed in Polkadot App',
      text: `${APP} · The allowance is not available`,
      tone: 'err',
    },
  },
  {
    story: 'As a user, I get an allowance answer with no outcomes and see the rejection in Polkadot App',
    outcome: { kind: 'ok', method: 'requestResourceAllocation', allocations: [] },
    notice: { label: 'Rejected in Polkadot App', text: APP, tone: 'idle', icon: BanIcon },
  },
  {
    story: 'As a user, I get an allowance answer without an outcome list and see the rejection in Polkadot App',
    outcome: { kind: 'ok', method: 'requestResourceAllocation' },
    notice: { label: 'Rejected in Polkadot App', text: APP, tone: 'idle', icon: BanIcon },
  },
  {
    story: 'As a user, I reject on my phone and see the rejection in Polkadot App',
    outcome: { kind: 'rejected' },
    notice: { label: 'Rejected in Polkadot App', text: APP, tone: 'idle', icon: BanIcon },
  },
  {
    story: 'As a user whose app took its request back, I see that the app cancelled it',
    outcome: { kind: 'withdrawn' },
    notice: { label: 'Request cancelled by the app', text: APP, tone: 'idle', icon: InfoIcon },
  },
  {
    story: 'As a user, I wait on a request Polkadot App fails and see the reason',
    outcome: { kind: 'failed', tag: 'HostFailure', reason: 'Phone went offline' },
    notice: {
      label: 'Not completed in Polkadot App',
      text: `${APP} · Phone went offline`,
      tone: 'err',
    },
  },
  {
    story: 'As a user, I get an answer Polkadot App sent that did not decode and see that it did not complete',
    outcome: { kind: 'undecodable' },
    notice: {
      label: 'Not completed in Polkadot App',
      text: `${APP} · Its answer could not be read`,
      tone: 'err',
    },
  },
  {
    story: 'As a user, I leave the page while a request waits and get no toast',
    outcome: { kind: 'gone' },
    notice: undefined,
  },
];

describe('phone outcome notice', () => {
  it.each(CASES)('$story', ({ outcome, notice }) => {
    // Given a waited request of the app that ended with the case's outcome
    const ended = { outcome, title: TITLE, app: APP };

    // When
    const shown = getPhoneOutcomeNotice(ended);

    // Then
    expect(shown).toEqual(notice);
  });
});
