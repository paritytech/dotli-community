// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { PhoneAsk } from '../../runtime/phone-methods.js';
import { phoneWaitingView, WAITING_BACKGROUND } from './phone-waiting-view.js';

describe('phone waiting view', () => {
  it.each<[string, PhoneAsk, string]>([
    ['As a user signing, I am told to tap Sign or Reject on my phone', 'sign', 'Sign Transaction'],
    ['As a user granting an allowance, I am told to Approve or Reject', 'approve', 'Allowance'],
  ])('%s', (_name, ask, title) => {
    // When
    const view = phoneWaitingView({ title, ask });

    // Then
    expect(view.title).toBe(title);
    expect(view.fields).toEqual([]);
    expect(view.buttons).toEqual([{ label: 'Wait in background', variant: 'secondary', result: WAITING_BACKGROUND }]);
    expect(view.dismissOnBackdrop).toBe(true);
    expect(view.dismissResult).toBe(WAITING_BACKGROUND);
    expect(view.closable).toBe(false);
    expect(view.body).toBeTypeOf('function');
  });

  it('As a user, the step for a signature and the step for an approval draw different bodies', () => {
    // When
    const sign = phoneWaitingView({ title: 'Sign Transaction', ask: 'sign' });
    const approve = phoneWaitingView({ title: 'Allowance', ask: 'approve' });

    // Then
    expect(sign.body).not.toBe(approve.body);
    expect(phoneWaitingView({ title: 'Sign Raw', ask: 'sign' }).body).toBe(sign.body);
  });
});
