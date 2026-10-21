// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { AllocationOutcome } from '@parity/truapi';
import { describe, expect, it } from 'vitest';
import { phoneOutcomeNotice } from './phone-outcome-notice.js';
import type { PhoneOutcome } from './phone-outcome.js';

const TITLE = 'Sign Transaction';
const APP = 'dotli.dot';

function noticeOf(outcome: PhoneOutcome) {
  return phoneOutcomeNotice({ outcome, title: TITLE, app: APP });
}

describe('phone outcome notice', () => {
  it('As a user, I sign on my phone and see the review title confirmed in Polkadot App', () => {
    // Given
    const outcome: PhoneOutcome = { kind: 'ok', method: 'signPayload' };

    // When
    const notice = noticeOf(outcome);

    // Then
    expect(notice).toMatchObject({
      text: `${TITLE}: signed in Polkadot App`,
      label: APP,
      tone: 'ok',
    });
  });

  it('As a user, I sign a raw message on my phone and see the same confirmation', () => {
    // Given
    const outcome: PhoneOutcome = { kind: 'ok', method: 'signRawWithLegacyAccount' };

    // When
    const notice = noticeOf(outcome);

    // Then
    expect(notice).toMatchObject({ text: `${TITLE}: signed in Polkadot App`, label: APP, tone: 'ok' });
  });

  it('As a user, I share my accounts and see that they were shared', () => {
    // Given
    const outcome: PhoneOutcome = { kind: 'ok', method: 'getAccount' };

    // When
    const notice = noticeOf(outcome);

    // Then
    expect(notice).toMatchObject({ text: 'Accounts shared', label: APP, tone: 'ok' });
  });

  it('As a user, I grant every allowance and see it granted', () => {
    // Given
    const outcome: PhoneOutcome = {
      kind: 'ok',
      method: 'requestResourceAllocation',
      allocations: ['Allocated', 'Allocated'],
    };

    // When
    const notice = noticeOf(outcome);

    // Then
    expect(notice).toMatchObject({ text: 'Allowance granted', label: APP, tone: 'ok' });
  });

  it('As a user, I grant some allowances and see the allowance partly granted', () => {
    // Given
    const allocations: AllocationOutcome[] = ['Allocated', 'Rejected'];
    const outcome: PhoneOutcome = { kind: 'ok', method: 'requestResourceAllocation', allocations };

    // When
    const notice = noticeOf(outcome);

    // Then
    expect(notice).toMatchObject({ text: 'Allowance partly granted', label: APP, tone: 'warn' });
  });

  it('As a user, I reject every allowance and see the rejection in Polkadot App', () => {
    // Given
    const allocations: AllocationOutcome[] = ['Rejected', 'Rejected'];
    const outcome: PhoneOutcome = { kind: 'ok', method: 'requestResourceAllocation', allocations };

    // When
    const notice = noticeOf(outcome);

    // Then
    expect(notice).toMatchObject({ text: 'Rejected in Polkadot App', label: APP, tone: 'info' });
  });

  it('As a user, I approve an allowance that is not available and see that Polkadot App did not complete it', () => {
    // Given
    const allocations: AllocationOutcome[] = ['Rejected', 'NotAvailable'];
    const outcome: PhoneOutcome = { kind: 'ok', method: 'requestResourceAllocation', allocations };

    // When
    const notice = noticeOf(outcome);

    // Then
    expect(notice).toMatchObject({
      text: "Polkadot App didn't complete the request: allowance not available",
      label: APP,
      tone: 'err',
    });
  });

  it('As a user, I get an allowance answer with no outcomes and see the rejection in Polkadot App', () => {
    // Given
    const outcome: PhoneOutcome = { kind: 'ok', method: 'requestResourceAllocation', allocations: [] };

    // When
    const notice = noticeOf(outcome);

    // Then
    expect(notice).toMatchObject({ text: 'Rejected in Polkadot App', label: APP, tone: 'info' });
  });

  it('As a user, I get an allowance answer without an outcome list and see the rejection in Polkadot App', () => {
    // Given
    const outcome: PhoneOutcome = { kind: 'ok', method: 'requestResourceAllocation' };

    // When
    const notice = noticeOf(outcome);

    // Then
    expect(notice).toMatchObject({ text: 'Rejected in Polkadot App', label: APP, tone: 'info' });
  });

  it('As a user, I reject on my phone and see the rejection in Polkadot App', () => {
    // Given
    const outcome: PhoneOutcome = { kind: 'rejected' };

    // When
    const notice = noticeOf(outcome);

    // Then
    expect(notice).toMatchObject({ text: 'Rejected in Polkadot App', label: APP, tone: 'info' });
  });

  it('As a user, I leave the wait and see that the app stopped waiting', () => {
    // Given
    const outcome: PhoneOutcome = { kind: 'withdrawn' };

    // When
    const notice = noticeOf(outcome);

    // Then
    expect(notice).toMatchObject({ text: 'The app stopped waiting', label: APP, tone: 'info' });
  });

  it('As a user, I see the reason when Polkadot App fails the request', () => {
    // Given
    const outcome: PhoneOutcome = { kind: 'failed', tag: 'HostFailure', reason: 'Phone went offline' };

    // When
    const notice = noticeOf(outcome);

    // Then
    expect(notice).toMatchObject({
      text: "Polkadot App didn't complete the request: Phone went offline",
      label: APP,
      tone: 'err',
    });
  });

  it('As a user, I get an answer Polkadot App sent that did not decode and see that it did not complete', () => {
    // Given
    const outcome: PhoneOutcome = { kind: 'undecodable' };

    // When
    const notice = noticeOf(outcome);

    // Then
    expect(notice).toMatchObject({
      text: "Polkadot App didn't complete the request: undecodable",
      label: APP,
      tone: 'err',
    });
  });

  it('As a user, I get no toast when the request went away with the page', () => {
    // Given
    const outcome: PhoneOutcome = { kind: 'gone' };

    // When
    const notice = noticeOf(outcome);

    // Then
    expect(notice).toBeUndefined();
  });
});
