// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { PermissionAuthorizationRequest } from '@parity/truapi-host';
import { describe, expect, it } from 'vitest';
import {
  getAuthorizationRequest,
  getFrameDirective,
  hasFrameDirective,
  type EnforceablePermissionName,
} from './permissionPolicy.js';

describe('PERMISSION_CATALOG', () => {
  it.each<{ name: EnforceablePermissionName; directive: string | null; request: PermissionAuthorizationRequest }>([
    { name: 'Notifications', directive: null, request: { tag: 'Device', value: 'Notifications' } },
    { name: 'Camera', directive: 'camera', request: { tag: 'Device', value: 'Camera' } },
    { name: 'Microphone', directive: 'microphone', request: { tag: 'Device', value: 'Microphone' } },
    { name: 'Location', directive: 'geolocation', request: { tag: 'Device', value: 'Location' } },
    { name: 'Motion', directive: 'accelerometer; gyroscope', request: { tag: 'Device', value: 'Motion' } },
    { name: 'Bluetooth', directive: 'bluetooth', request: { tag: 'Device', value: 'Bluetooth' } },
    { name: 'NFC', directive: 'nfc', request: { tag: 'Device', value: 'NFC' } },
    { name: 'Clipboard', directive: 'clipboard-read', request: { tag: 'Device', value: 'Clipboard' } },
    { name: 'Biometrics', directive: 'publickey-credentials-get', request: { tag: 'Device', value: 'Biometrics' } },
    { name: 'IdentityDisclosure', directive: null, request: { tag: 'IdentityDisclosure' } },
    { name: 'ChainSubmit', directive: null, request: { tag: 'Remote', value: { permission: { tag: 'ChainSubmit' } } } },
    {
      name: 'PreimageSubmit',
      directive: null,
      request: { tag: 'Remote', value: { permission: { tag: 'PreimageSubmit' } } },
    },
    {
      name: 'StatementSubmit',
      directive: null,
      request: { tag: 'Remote', value: { permission: { tag: 'StatementSubmit' } } },
    },
  ])(
    'As a dotli integrator, I look up $name and get its frame directive and its core request',
    ({ name, directive, request }) => {
      // Given the permission's name, as a product asks for it
      const permission = name;

      // When its frame directive, its reload and its core request are looked up
      const frameDirective = getFrameDirective(permission);
      const reloads = hasFrameDirective(permission);
      const asked = getAuthorizationRequest(permission);

      // Then a grant adds that directive, reloads only with one, and the core is asked that request
      expect(frameDirective).toBe(directive);
      expect(reloads).toBe(directive !== null);
      expect(asked).toEqual(request);
    },
  );
});
