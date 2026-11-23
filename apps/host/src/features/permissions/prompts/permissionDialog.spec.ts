// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getGrantButtons, hostAccessDialog, permissionRequestDialog } from './permissionDialog.js';

describe('permission request dialog', () => {
  it('As a dotli user, a prompt names the app, and a dismissal is no denial', () => {
    // When
    const view = permissionRequestDialog({ app: 'myapp.dot', permission: 'Notifications' });

    // Then
    expect(view.fields.map(field => field.value)).toContain('myapp.dot');
    expect(view.dismissOnBackdrop).toBe(true);
    expect(view.dismissResult).toBe('dismissed');
  });
});

describe('host access dialog', () => {
  it('As a dotli user, a fetch prompt names the app and the host, and a dismissal is no denial', () => {
    // When
    const view = hostAccessDialog({ app: 'myapp.dot', host: 'api.example.com' });

    // Then
    expect(view.fields.map(field => field.value)).toEqual(expect.arrayContaining(['myapp.dot', 'api.example.com']));
    expect(view.dismissResult).toBe('dismissed');
  });
});

describe('grant buttons', () => {
  it.each([
    {
      story: 'for a signature',
      params: { allowOnce: false, allowLabel: 'Sign', denyLabel: 'Cancel' },
      expected: [
        { label: 'Cancel', variant: 'danger', result: 'denied' },
        { label: 'Sign', variant: 'primary', result: 'granted' },
      ],
    },
    {
      story: 'with a one-time grant',
      params: { allowOnce: true },
      expected: [
        { label: 'Deny', variant: 'danger', result: 'denied' },
        { label: 'Always allow', variant: 'secondary', result: 'granted' },
        { label: 'Allow once', variant: 'primary', result: 'granted-once' },
      ],
    },
  ])('As a dotli user, I open a grant dialog $story and see its answer buttons in order', ({ params, expected }) => {
    // Given the dialog's params, from the table

    // When
    const buttons = getGrantButtons(params);

    // Then
    expect(buttons).toEqual(expected);
  });
});
