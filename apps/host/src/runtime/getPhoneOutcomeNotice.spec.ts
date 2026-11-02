// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { NotificationParams } from '@dotli/ui';
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
    story: 'As a user, I sign on my phone and see the review title confirmed in Polkadot App',
    outcome: { kind: 'ok', method: 'signPayload' },
    notice: { text: `${TITLE}: signed in Polkadot App`, label: APP, tone: 'ok' },
  },
  {
    story: 'As a user, I sign a raw message on my phone and see the same confirmation',
    outcome: { kind: 'ok', method: 'signRawWithLegacyAccount' },
    notice: { text: `${TITLE}: signed in Polkadot App`, label: APP, tone: 'ok' },
  },
  {
    story: 'As a user, I share my accounts and see that they were shared',
    outcome: { kind: 'ok', method: 'getAccount' },
    notice: { text: 'Accounts shared', label: APP, tone: 'ok' },
  },
  {
    story: 'As a user, I grant every allowance and see it granted',
    outcome: { kind: 'ok', method: 'requestResourceAllocation', allocations: ['Allocated', 'Allocated'] },
    notice: { text: 'Allowance granted', label: APP, tone: 'ok' },
  },
  {
    story: 'As a user, I grant some allowances and see the allowance partly granted',
    outcome: { kind: 'ok', method: 'requestResourceAllocation', allocations: ['Allocated', 'Rejected'] },
    notice: { text: 'Allowance partly granted', label: APP, tone: 'warn' },
  },
  {
    story: 'As a user, I reject every allowance and see the rejection in Polkadot App',
    outcome: { kind: 'ok', method: 'requestResourceAllocation', allocations: ['Rejected', 'Rejected'] },
    notice: { text: 'Rejected in Polkadot App', label: APP, tone: 'info' },
  },
  {
    story: 'As a user, I approve an allowance that is not available and see that Polkadot App did not complete it',
    outcome: { kind: 'ok', method: 'requestResourceAllocation', allocations: ['Rejected', 'NotAvailable'] },
    notice: { text: "Polkadot App didn't complete the request: allowance not available", label: APP, tone: 'err' },
  },
  {
    story: 'As a user, I get an allowance answer with no outcomes and see the rejection in Polkadot App',
    outcome: { kind: 'ok', method: 'requestResourceAllocation', allocations: [] },
    notice: { text: 'Rejected in Polkadot App', label: APP, tone: 'info' },
  },
  {
    story: 'As a user, I get an allowance answer without an outcome list and see the rejection in Polkadot App',
    outcome: { kind: 'ok', method: 'requestResourceAllocation' },
    notice: { text: 'Rejected in Polkadot App', label: APP, tone: 'info' },
  },
  {
    story: 'As a user, I reject on my phone and see the rejection in Polkadot App',
    outcome: { kind: 'rejected' },
    notice: { text: 'Rejected in Polkadot App', label: APP, tone: 'info' },
  },
  {
    story: 'As a user, I leave the wait and see that the app stopped waiting',
    outcome: { kind: 'withdrawn' },
    notice: { text: 'The app stopped waiting', label: APP, tone: 'info' },
  },
  {
    story: 'As a user, I wait on a request Polkadot App fails and see the reason',
    outcome: { kind: 'failed', tag: 'HostFailure', reason: 'Phone went offline' },
    notice: { text: "Polkadot App didn't complete the request: Phone went offline", label: APP, tone: 'err' },
  },
  {
    story: 'As a user, I get an answer Polkadot App sent that did not decode and see that it did not complete',
    outcome: { kind: 'undecodable' },
    notice: { text: "Polkadot App didn't complete the request: undecodable", label: APP, tone: 'err' },
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
