// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { recordPermissionChange, recordPermissionsChanged } from '../../src/state/permissions.js';

function capture(name: string): { details: unknown[]; stop: () => void } {
  const details: unknown[] = [];
  const listener = (e: Event): void => {
    details.push((e as CustomEvent).detail);
  };
  window.addEventListener(name, listener);
  return {
    details,
    stop: () => {
      window.removeEventListener(name, listener);
    },
  };
}

describe('permission changes', () => {
  it('As a listener, a grant fires dotli:permission-changed { label, permission } and no device change', () => {
    // Given
    const grants = capture('dotli:permission-changed');
    const devices = capture('dotli:device-permission-changed');

    // When
    recordPermissionChange({
      kind: 'grant',
      label: 'myapp',
      permission: 'camera',
    });

    // Then
    expect(grants.details).toEqual([{ label: 'myapp', permission: 'camera' }]);
    expect(devices.details).toEqual([]);
    grants.stop();
    devices.stop();
  });

  it('As a listener, each device change fires dotli:device-permission-changed { label, permission } and no grant', () => {
    // Given
    const grants = capture('dotli:permission-changed');
    const devices = capture('dotli:device-permission-changed');

    // When
    recordPermissionChange({
      kind: 'device',
      label: 'myapp',
      permission: 'camera',
    });
    recordPermissionChange({
      kind: 'device',
      label: 'myapp',
      permission: 'camera',
    });

    // Then
    expect(devices.details).toEqual([
      { label: 'myapp', permission: 'camera' },
      { label: 'myapp', permission: 'camera' },
    ]);
    expect(grants.details).toEqual([]);
    grants.stop();
    devices.stop();
  });
});

describe('permissions changed together', () => {
  it('As a user resetting a device permission among others, the app hears one grant change, so the committed policy reloads it at most once', () => {
    // Given
    const grants = capture('dotli:permission-changed');
    const devices = capture('dotli:device-permission-changed');

    // When
    recordPermissionsChanged('myapp', ['Notifications', 'Camera', 'Microphone', 'ChainSubmit']);

    // Then
    expect(grants.details).toEqual([{ label: 'myapp', permission: 'Notifications' }]);
    expect(devices.details).toEqual([]);
    grants.stop();
    devices.stop();
  });

  it('As a user whose reset changed nothing, nothing is announced', () => {
    // Given
    const grants = capture('dotli:permission-changed');
    const devices = capture('dotli:device-permission-changed');

    // When
    recordPermissionsChanged('myapp', []);

    // Then
    expect(grants.details).toEqual([]);
    expect(devices.details).toEqual([]);
    grants.stop();
    devices.stop();
  });
});
