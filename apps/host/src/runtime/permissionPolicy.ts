// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The permissions a product can hold, and the iframe `allow` directive each device permission maps to.

import type { HostDevicePermissionRequest } from '@parity/truapi';

export type DevicePermissionName = HostDevicePermissionRequest;

export type PermissionName =
  DevicePermissionName | 'ChainSubmit' | 'IdentityDisclosure' | 'PreimageSubmit' | 'StatementSubmit';

export type AutoGrantDevicePermission = 'OpenUrl';

export type EnforceableDevicePermission = Exclude<DevicePermissionName, AutoGrantDevicePermission>;

export type EnforceablePermissionName = Exclude<PermissionName, AutoGrantDevicePermission>;

export type PermissionStatus = 'ask' | 'granted' | 'denied';

/** Statuses for some of an app's permissions, as one change writes them. */
export type PermissionTargets = Readonly<Partial<Record<EnforceablePermissionName, PermissionStatus>>>;

/** What the device lets the app use, or what the app does with the account and the network. */
export type PermissionGroup = 'device' | 'app';

/** A variant absent here is still persisted by the core but leaves the iframe `allow` attribute alone. */
export const DEVICE_PERMISSION_POLICY: Partial<Record<DevicePermissionName, string>> = {
  Camera: 'camera',
  Microphone: 'microphone',
  Location: 'geolocation',
  // Device motion and orientation events need both sensors.
  Motion: 'accelerometer; gyroscope',
  Bluetooth: 'bluetooth',
  // Write is always allowed, read needs consent.
  Clipboard: 'clipboard-read',
  Biometrics: 'publickey-credentials-get',
  // Chromium-only, ignored elsewhere.
  NFC: 'nfc',
  // Notifications has no directive, and its own prompt gates it with no iframe reload.
};

/**
 * Navigation via anchor or window.open has no host-side enforcement point, so these always resolve
 * `true` and stay out of the menu, where a control that cannot block would mislead.
 */
export const AUTO_GRANT_DEVICE_PERMISSIONS: ReadonlySet<DevicePermissionName> = new Set<AutoGrantDevicePermission>([
  'OpenUrl',
]);

/** In menu display order. */
export const ALL_PERMISSIONS: readonly {
  name: EnforceablePermissionName;
  label: string;
  group: PermissionGroup;
}[] = [
  { name: 'Notifications', label: 'Notifications', group: 'device' },
  { name: 'Camera', label: 'Camera', group: 'device' },
  { name: 'Microphone', label: 'Microphone', group: 'device' },
  { name: 'Location', label: 'Location', group: 'device' },
  { name: 'Motion', label: 'Motion', group: 'device' },
  { name: 'Bluetooth', label: 'Bluetooth', group: 'device' },
  { name: 'NFC', label: 'NFC', group: 'device' },
  { name: 'Clipboard', label: 'Clipboard', group: 'device' },
  { name: 'Biometrics', label: 'Biometrics', group: 'device' },
  { name: 'IdentityDisclosure', label: 'Identity disclosure', group: 'app' },
  { name: 'ChainSubmit', label: 'Sign transactions', group: 'app' },
  { name: 'PreimageSubmit', label: 'Submit preimages', group: 'app' },
  { name: 'StatementSubmit', label: 'Submit statements', group: 'app' },
];

/** True for a device permission a user can be asked for, false for an auto-granted one. */
export function isEnforceableDevicePermission(name: DevicePermissionName): name is EnforceableDevicePermission {
  return !AUTO_GRANT_DEVICE_PERMISSIONS.has(name);
}

/** True when the permission maps to an iframe `allow` directive. */
export function isDevicePermission(name: string): boolean {
  return name in DEVICE_PERMISSION_POLICY;
}
