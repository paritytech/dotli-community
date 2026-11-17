// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { PermissionAuthorizationRequest } from '@parity/truapi-host';
import { describe, expect, it } from 'vitest';
import { getAuthorizationRequest, type EnforceablePermissionName } from './permissionPolicy.js';

describe('getAuthorizationRequest', () => {
  it.each<{ name: EnforceablePermissionName; request: PermissionAuthorizationRequest }>([
    { name: 'Camera', request: { tag: 'Device', value: 'Camera' } },
    { name: 'IdentityDisclosure', request: { tag: 'IdentityDisclosure' } },
    { name: 'ChainSubmit', request: { tag: 'Remote', value: { permission: { tag: 'ChainSubmit' } } } },
  ])('As a dotli integrator, I look up $name and get its core request', ({ name, request }) => {
    // When the core request of the permission a product asks for is looked up
    const asked = getAuthorizationRequest(name);

    // Then the core is asked that request
    expect(asked).toEqual(request);
  });
});
