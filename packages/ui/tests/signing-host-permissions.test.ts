// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { PermissionAuthorizationRequest } from '@parity/truapi-host';
import { holdPermissionsInMemory } from '../src/signing-host-permissions.js';

const CAMERA: PermissionAuthorizationRequest = { tag: 'Device', value: 'Camera' };
const IDENTITY: PermissionAuthorizationRequest = { tag: 'IdentityDisclosure' };

type PermissionMethods = Parameters<typeof holdPermissionsInMemory>[0];

function signingRuntime(): PermissionMethods {
  const missing = (): Promise<never> =>
    Promise.reject(new TypeError('runtime.permissionAuthorizationStatuses is not a function'));
  const runtime: PermissionMethods = {
    getPermissionAuthorizationStatus: missing,
    getPermissionAuthorizationStatuses: missing,
    setPermissionAuthorizationStatus: missing,
  };
  holdPermissionsInMemory(runtime);
  return runtime;
}

describe('signing host permissions held in memory', () => {
  it('As a local wallet user, I open a product and every permission reads as not decided yet', async () => {
    // Given
    const runtime = signingRuntime();

    // When
    const statuses = await runtime.getPermissionAuthorizationStatuses('app.dot', [CAMERA, IDENTITY]);

    // Then
    expect(statuses).toEqual(['NotDetermined', 'NotDetermined']);
  });

  it('As a local wallet user, I grant a permission and the product sees it until the page reloads', async () => {
    // Given
    const runtime = signingRuntime();

    // When
    await runtime.setPermissionAuthorizationStatus('app.dot', CAMERA, 'Authorized');

    // Then
    await expect(runtime.getPermissionAuthorizationStatus('app.dot', CAMERA)).resolves.toBe('Authorized');
    await expect(runtime.getPermissionAuthorizationStatuses('app.dot', [CAMERA, IDENTITY])).resolves.toEqual([
      'Authorized',
      'NotDetermined',
    ]);
  });

  it('As a local wallet user, I grant a permission to one product and another product still has to ask', async () => {
    // Given
    const runtime = signingRuntime();

    // When
    await runtime.setPermissionAuthorizationStatus('app.dot', CAMERA, 'Denied');

    // Then
    await expect(runtime.getPermissionAuthorizationStatus('other.dot', CAMERA)).resolves.toBe('NotDetermined');
  });
});
