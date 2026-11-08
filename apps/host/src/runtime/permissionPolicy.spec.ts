// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { PermissionAuthorizationRequest } from '@parity/truapi-host';
import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  AUTO_GRANT_DEVICE_PERMISSIONS,
  getAuthorizationRequest,
  getFrameDirective,
  hasFrameDirective,
  isEnforceableDevicePermission,
  PERMISSION_GROUPS,
  type EnforceablePermissionName,
  type PermissionGroup,
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

describe('PERMISSION_GROUPS', () => {
  it.each<{ group: PermissionGroup; label: string }>([
    { group: 'device', label: 'Device' },
    { group: 'app', label: 'Account and chain' },
  ])('As a user, I open the permissions menu and the $group group is headed $label', ({ group, label }) => {
    // Given a menu group
    const shown = group;

    // When its heading is read
    const heading = PERMISSION_GROUPS[shown].label;

    // Then it is the group's heading
    expect(heading).toBe(label);
  });
});

describe('isEnforceableDevicePermission', () => {
  it.each([
    { name: 'OpenUrl', enforced: false },
    { name: 'Notifications', enforced: true },
    { name: 'Camera', enforced: true },
    { name: 'Microphone', enforced: true },
  ] as const)(
    'As a dotli integrator, I ask whether $name is enforced and learn only a permission a user can be asked for is ($enforced)',
    ({ name, enforced }) => {
      // Given the device permission's name
      const asked = name;

      // When it is checked
      const answer = isEnforceableDevicePermission(asked);

      // Then it is enforced only when a user can be asked for it
      expect(answer).toBe(enforced);
    },
  );
});

describe('ALL_PERMISSIONS (data invariants)', () => {
  it('As a dotli integrator, I list the permissions a user is asked for and find no auto-granted device permission', () => {
    // Given the auto-granted set read as plain names, so every listed name can be looked up
    const autoGranted: ReadonlySet<string> = AUTO_GRANT_DEVICE_PERMISSIONS;

    // When the listed permissions are matched against it
    const listed = ALL_PERMISSIONS.filter(({ name }) => autoGranted.has(name));

    // Then none is auto-granted
    expect(listed).toEqual([]);
  });

  it('As a user, I open the permissions menu and see the nine device permissions, then the four app permissions', () => {
    // Given the permissions the menu lists, in order
    const listed = ALL_PERMISSIONS;

    // When they are split by group
    const device = listed.filter(({ group }) => group === 'device').map(({ name }) => name);
    const app = listed.filter(({ group }) => group === 'app').map(({ name }) => name);
    const groups = listed.map(({ group }) => group);

    // Then the device permissions come first, then the app permissions
    expect(device).toEqual([
      'Notifications',
      'Camera',
      'Microphone',
      'Location',
      'Motion',
      'Bluetooth',
      'NFC',
      'Clipboard',
      'Biometrics',
    ]);
    expect(app).toEqual(['IdentityDisclosure', 'ChainSubmit', 'PreimageSubmit', 'StatementSubmit']);
    expect(groups).toEqual([
      ...ALL_PERMISSIONS.slice(0, 9).map(() => 'device'),
      ...ALL_PERMISSIONS.slice(9).map(() => 'app'),
    ]);
  });
});
