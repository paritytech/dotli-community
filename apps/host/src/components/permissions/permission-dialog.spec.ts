// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from '../../runtime/permissions.js';
import { permissionIcon } from './permission-icons.js';
import { permissionRequestDialog, type PermissionRequest } from './permission-dialog.js';

const CAMERA: PermissionRequest = { app: 'myapp.dot', permission: 'Camera', allowOnce: false, reloads: true };

function footer(request: PermissionRequest): [string, string][] {
  return permissionRequestDialog(request).buttons.map(b => [b.label, b.variant]);
}

describe('permission request dialog', () => {
  it('As a dotli user, a two-way prompt offers Deny and Allow', () => {
    // When / Then
    expect(footer(CAMERA)).toEqual([
      ['Deny', 'danger'],
      ['Allow', 'primary'],
    ]);
  });

  it('As a dotli user, a three-way prompt highlights Allow once and draws Deny as the destructive answer', () => {
    // When / Then
    expect(footer({ app: 'myapp.dot', permission: 'ChainSubmit', allowOnce: true, reloads: false })).toEqual([
      ['Deny', 'danger'],
      ['Always allow', 'secondary'],
      ['Allow once', 'primary'],
    ]);
  });

  it('As a dotli user, a device prompt says that granting reloads the application', () => {
    // When
    const view = permissionRequestDialog(CAMERA);

    // Then
    expect(view.notice).toBe('Granting this permission will reload the application.');
  });

  it('As a dotli user, a prompt names the app and what the permission lets it do, and a dismissal is no denial', () => {
    // When
    const view = permissionRequestDialog({ ...CAMERA, reloads: false });

    // Then
    expect(view.fields).toEqual([
      { label: 'Application', value: 'myapp.dot' },
      { label: 'Permission', value: 'Access your camera for photo and video capture' },
    ]);
    expect(view.notice).toBeUndefined();
    expect(view.dismissOnBackdrop).toBe(true);
    expect(view.dismissResult).toBe('dismissed');
  });

  it('As a dotli user, every permission the menu lists asks with its own icon and says what it allows', () => {
    // Given
    const names = ALL_PERMISSIONS.map(permission => permission.name);

    // When
    const dialogs = names.map(permission =>
      permissionRequestDialog({ app: 'app.dot', permission, allowOnce: false, reloads: false }),
    );

    // Then
    expect(dialogs.map(dialog => dialog.icon)).toEqual(names.map(name => permissionIcon(name)));
    expect(new Set(dialogs.map(dialog => dialog.fields[1]?.value)).size).toBe(names.length);
  });
});
