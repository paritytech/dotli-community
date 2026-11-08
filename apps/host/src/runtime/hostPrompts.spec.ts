// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { PermissionDecision } from '@parity/truapi-host';
import { ERRORS } from './errors.js';
import type { PermissionStatus } from './permissionPolicy.js';
import { getLastingStatus, isDismissed, isGranted, toPermissionDecision, type GrantAnswer } from './hostPrompts.js';

describe('GrantAnswer', () => {
  it.each<{
    answer: GrantAnswer;
    granted: boolean;
    dismissed: boolean;
    decision: PermissionDecision;
    lasting: Exclude<PermissionStatus, 'ask'> | null;
  }>([
    { answer: 'granted', granted: true, dismissed: false, decision: 'AllowAlways', lasting: 'granted' },
    { answer: 'granted-once', granted: true, dismissed: false, decision: 'AllowOnce', lasting: null },
    { answer: 'denied', granted: false, dismissed: false, decision: 'Deny', lasting: 'denied' },
  ])(
    'As the host, I read a $answer answer and get granted $granted, decision $decision and lasting status $lasting',
    ({ answer, granted, dismissed, decision, lasting }) => {
      // Given the user's answer to a grant prompt, from the table

      // When the host reads every view of it
      const isAllowed = isGranted(answer);
      const isClosed = isDismissed(answer);
      const core = toPermissionDecision(answer);
      const recorded = getLastingStatus(answer);

      // Then each view matches the row
      expect(isAllowed).toBe(granted);
      expect(isClosed).toBe(dismissed);
      expect(core).toBe(decision);
      expect(recorded).toBe(lasting);
    },
  );

  it('As the host, I read a dismissed answer as no grant and no record, and the core hears a rejection', () => {
    // Given a prompt the user closed without answering
    const answer: GrantAnswer = 'dismissed';

    // When the host reads every view of a dismissal
    const isAllowed = isGranted(answer);
    const isClosed = isDismissed(answer);
    const recorded = getLastingStatus(answer);
    let thrown: unknown;
    try {
      toPermissionDecision(answer);
    } catch (error) {
      thrown = error;
    }

    // Then nothing is granted or recorded, and the core's decision rejects
    expect(isAllowed).toBe(false);
    expect(isClosed).toBe(true);
    expect(recorded).toBeNull();
    expect(thrown).toEqual(new Error(ERRORS.PERMISSION_DIALOG_DISMISSED));
  });
});
