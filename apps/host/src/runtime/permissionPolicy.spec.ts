// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  AUTO_GRANT_DEVICE_PERMISSIONS,
  DEVICE_PERMISSION_POLICY,
  isDevicePermission,
  isEnforceableDevicePermission,
} from './permissionPolicy.js';

describe('isDevicePermission', () => {
  // Notifications is host-gated separately but has no Permissions Policy directive. OpenUrl is auto-granted.
  it.each([
    { name: 'Camera', device: true },
    { name: 'Microphone', device: true },
    { name: 'Bluetooth', device: true },
    { name: 'Location', device: true },
    { name: 'Motion', device: true },
    { name: 'Clipboard', device: true },
    { name: 'Biometrics', device: true },
    { name: 'NFC', device: true },
    { name: 'ChainSubmit', device: false },
    { name: 'PreimageSubmit', device: false },
    { name: 'StatementSubmit', device: false },
    { name: 'IdentityDisclosure', device: false },
    { name: 'Notifications', device: false },
    { name: 'OpenUrl', device: false },
  ])(
    'As a dotli integrator, I ask whether $name is a device permission and learn it is one only with a Permissions Policy directive ($device)',
    ({ name, device }) => {
      // Given the permission's name, as a product asks for it
      const asked = name;

      // When it is checked
      const answer = isDevicePermission(asked);

      // Then it is a device permission only with a directive
      expect(answer).toBe(device);
    },
  );
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

describe('DEVICE_PERMISSION_POLICY (sanity)', () => {
  it('As a dotli integrator, I list the Permissions Policy directives and find none for an auto-granted device permission', () => {
    // Given the auto-granted device permissions
    const autoGranted = [...AUTO_GRANT_DEVICE_PERMISSIONS];

    // When each is looked up among the directives
    const directed = autoGranted.filter(auto => auto in DEVICE_PERMISSION_POLICY);

    // Then none has one
    expect(directed).toEqual([]);
  });
});
