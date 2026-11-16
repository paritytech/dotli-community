// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { phoneWaitingView } from './phoneWaitingView.js';

describe('phone waiting view', () => {
  it('As a user, the step for a signature and the step for an approval draw different bodies', () => {
    // When
    const sign = phoneWaitingView({ title: 'Sign Transaction', ask: 'sign' });
    const approve = phoneWaitingView({ title: 'Allowance', ask: 'approve' });

    // Then
    expect(sign.body).not.toBe(approve.body);
    expect(phoneWaitingView({ title: 'Sign Raw', ask: 'sign' }).body).toBe(sign.body);
  });
});
