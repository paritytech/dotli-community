// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { phoneWaitingView, WAITING_BACKGROUND } from './phone-waiting-view.js';

describe('phone waiting view', () => {
  it('As a user signing, I am told to tap Sign or Reject on my phone', () => {
    // When
    const view = phoneWaitingView({ title: 'Sign Transaction', ask: 'sign' });

    // Then
    expect(view.title).toBe('Sign Transaction');
    expect(view.fields).toEqual([]);
    expect(view.buttons).toEqual([{ label: 'Wait in background', variant: 'secondary', result: WAITING_BACKGROUND }]);
    expect(view.dismissOnBackdrop).toBe(true);
    expect(view.dismissResult).toBe(WAITING_BACKGROUND);
    expect(view.closable).toBe(false);
    expect(view.body).toBeTypeOf('function');
  });

  it('As a user granting an allowance, I am told to Approve or Reject', () => {
    // When
    const view = phoneWaitingView({ title: 'Allowance', ask: 'approve' });

    // Then
    expect(view.title).toBe('Allowance');
    expect(view.fields).toEqual([]);
    expect(view.buttons).toEqual([{ label: 'Wait in background', variant: 'secondary', result: WAITING_BACKGROUND }]);
    expect(view.dismissOnBackdrop).toBe(true);
    expect(view.dismissResult).toBe(WAITING_BACKGROUND);
    expect(view.closable).toBe(false);
    expect(view.body).toBeTypeOf('function');
  });
});
