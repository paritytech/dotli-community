// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The permissions a product can hold, with each one's facts in one table.

import { getKeys } from '@dotli/shared';
import type { HostDevicePermissionRequest } from '@parity/truapi';
import type { PermissionAuthorizationRequest } from '@parity/truapi-host';

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

type PermissionFacts = {
  /** The menu's name for it. */
  label: string;
  group: PermissionGroup;
  /** What it lets the app do, as the permission dialog says it. */
  description: string;
  /** The iframe `allow` directive a grant adds, null where the core alone gates it. */
  frameDirective: string | null;
  /** Its status under the Trusted preset. */
  trusted: PermissionStatus;
};

/** Every permission a user can be asked for, in menu order. */
export const PERMISSION_CATALOG = {
  Notifications: {
    label: 'Notifications',
    group: 'device',
    description: 'Show in-app and system notifications',
    // Notifications has no directive, and its own prompt gates it with no iframe reload.
    frameDirective: null,
    trusted: 'granted',
  },
  Camera: {
    label: 'Camera',
    group: 'device',
    description: 'Access your camera for photo and video capture',
    frameDirective: 'camera',
    trusted: 'granted',
  },
  Microphone: {
    label: 'Microphone',
    group: 'device',
    description: 'Access your microphone for audio input',
    frameDirective: 'microphone',
    trusted: 'granted',
  },
  Location: {
    label: 'Location',
    group: 'device',
    description: 'Access your location for geolocation services',
    frameDirective: 'geolocation',
    trusted: 'ask',
  },
  Motion: {
    label: 'Motion',
    group: 'device',
    description: "Read your device's motion and orientation sensors",
    // Device motion and orientation events need both sensors.
    frameDirective: 'accelerometer; gyroscope',
    trusted: 'ask',
  },
  Bluetooth: {
    label: 'Bluetooth',
    group: 'device',
    description: 'Connect to nearby Bluetooth devices',
    frameDirective: 'bluetooth',
    trusted: 'ask',
  },
  NFC: {
    label: 'NFC',
    group: 'device',
    description: 'Read and write nearby NFC tags',
    // Chromium-only, ignored elsewhere.
    frameDirective: 'nfc',
    trusted: 'ask',
  },
  Clipboard: {
    label: 'Clipboard',
    group: 'device',
    description: 'Read text and data from your clipboard',
    // Write is always allowed, read needs consent.
    frameDirective: 'clipboard-read',
    trusted: 'granted',
  },
  Biometrics: {
    label: 'Biometrics',
    group: 'device',
    description: 'Authenticate with a platform passkey or biometric prompt',
    frameDirective: 'publickey-credentials-get',
    trusted: 'ask',
  },
  IdentityDisclosure: {
    label: 'Identity disclosure',
    group: 'app',
    description: 'Share your primary DotNS identity with this app',
    frameDirective: null,
    trusted: 'granted',
  },
  ChainSubmit: {
    label: 'Sign transactions',
    group: 'app',
    description: 'Sign and submit network transactions on your behalf',
    frameDirective: null,
    trusted: 'granted',
  },
  PreimageSubmit: {
    label: 'Submit preimages',
    group: 'app',
    description: 'Store preimage data on the Bulletin network',
    frameDirective: null,
    trusted: 'granted',
  },
  StatementSubmit: {
    label: 'Submit statements',
    group: 'app',
    description: 'Submit signed statements to the statement store',
    frameDirective: null,
    trusted: 'granted',
  },
} satisfies Record<EnforceablePermissionName, PermissionFacts>;

/** Each menu group's heading, in menu order. */
export const PERMISSION_GROUPS = {
  device: { label: 'Device' },
  app: { label: 'Account and chain' },
} satisfies Record<PermissionGroup, { label: string }>;

/**
 * Navigation via anchor or window.open has no host-side enforcement point, so these always resolve
 * `true` and stay out of the menu, where a control that cannot block would mislead.
 */
const AUTO_GRANT_DEVICE_PERMISSIONS: ReadonlySet<DevicePermissionName> = new Set<AutoGrantDevicePermission>([
  'OpenUrl',
]);

/** In menu display order. */
export const ALL_PERMISSIONS: readonly {
  name: EnforceablePermissionName;
  label: string;
  group: PermissionGroup;
}[] = getKeys(PERMISSION_CATALOG).map(name => ({
  name,
  label: PERMISSION_CATALOG[name].label,
  group: PERMISSION_CATALOG[name].group,
}));

/** True for a device permission a user can be asked for, false for an auto-granted one. */
export function isEnforceableDevicePermission(name: DevicePermissionName): name is EnforceableDevicePermission {
  return !AUTO_GRANT_DEVICE_PERMISSIONS.has(name);
}

/** The iframe `allow` directive a grant of `name` adds, null when it adds none. Never throws. */
export function getFrameDirective(name: EnforceablePermissionName): string | null {
  return PERMISSION_CATALOG[name].frameDirective;
}

/** True when granting `name` adds an iframe `allow` directive, so the frame reloads. Never throws. */
export function hasFrameDirective(name: EnforceablePermissionName): boolean {
  return getFrameDirective(name) !== null;
}

/** The core's request for `name`. Never throws. */
export function getAuthorizationRequest(name: EnforceablePermissionName): PermissionAuthorizationRequest {
  switch (name) {
    case 'ChainSubmit':
    case 'PreimageSubmit':
    case 'StatementSubmit':
      return {
        tag: 'Remote',
        value: { permission: { tag: name } },
      };
    case 'IdentityDisclosure':
      return { tag: 'IdentityDisclosure' };
    case 'Notifications':
    case 'Camera':
    case 'Microphone':
    case 'Bluetooth':
    case 'NFC':
    case 'Location':
    case 'Motion':
    case 'Clipboard':
    case 'Biometrics':
      return { tag: 'Device', value: name };
  }
}
