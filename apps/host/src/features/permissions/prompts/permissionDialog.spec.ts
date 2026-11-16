// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getGrantButtons, permissionRequestDialog, type PermissionRequest } from './permissionDialog.js';

const CAMERA: PermissionRequest = { app: 'myapp.dot', permission: 'Camera', allowOnce: false, reloads: true };

describe('permission request dialog', () => {
  it('As a dotli user, a device prompt says that granting reloads the application', () => {
    // When
    const view = permissionRequestDialog(CAMERA);

    // Then
    expect(view.notice).toBe('Granting this permission will reload the application.');
  });

  it('As a dotli user, a prompt names the app, and a dismissal is no denial', () => {
    // When
    const view = permissionRequestDialog({ ...CAMERA, reloads: false });

    // Then
    expect(view.fields).toContainEqual({ label: 'Application', value: 'myapp.dot' });
    expect(view.notice).toBeUndefined();
    expect(view.dismissOnBackdrop).toBe(true);
    expect(view.dismissResult).toBe('dismissed');
  });
});

describe('grant buttons', () => {
  it.each([
    {
      story: 'with no one-time grant',
      params: { allowOnce: false },
      expected: [
        { label: 'Deny', variant: 'danger', result: 'denied' },
        { label: 'Allow', variant: 'primary', result: 'granted' },
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
    {
      story: 'for a signature',
      params: { allowOnce: false, allowLabel: 'Sign', denyLabel: 'Cancel' },
      expected: [
        { label: 'Cancel', variant: 'danger', result: 'denied' },
        { label: 'Sign', variant: 'primary', result: 'granted' },
      ],
    },
    {
      story: 'for a lasting review with a one-time grant',
      params: { allowOnce: true, allowLabel: 'Allow', denyLabel: 'Cancel' },
      expected: [
        { label: 'Cancel', variant: 'danger', result: 'denied' },
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
