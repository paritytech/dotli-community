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

/** True when dot.li grants the permission, so the app may use it without asking. */
export function isPermissionGranted(status: PermissionStatus): boolean {
  switch (status) {
    case 'granted':
      return true;
    case 'ask':
    case 'denied':
      return false;
  }
}

/** Statuses for some of an app's permissions, as one change writes them. */
export type PermissionTargets = Readonly<Partial<Record<EnforceablePermissionName, PermissionStatus>>>;

/** What the device lets the app use, or what the app does with the account and the network. */
export type PermissionGroup = 'device' | 'app';

/** A browser permission whose status the page can read. */
export type BrowserCheck = 'notifications' | 'camera' | 'microphone' | 'geolocation';

/** The iframe `allow` directive a permission gates, and whose consent lets it in. */
type FrameGate = {
  directive: string;
  /**
   * `browser`: the browser's own prompt is the consent, as on any website, so the directive is in unless dot.li blocks
   * it. `dotli`: the directive is in only once dot.li grants it.
   */
  consent: 'browser' | 'dotli';
};

type PermissionFacts = {
  /** The menu's name for it. */
  label: string;
  group: PermissionGroup;
  /** What it lets the app do, as the permission dialog says it. */
  description: string;
  /** The browser permission that reports its status, null where the browser reports none. */
  browserCheck: BrowserCheck | null;
} & (
  | {
      frame: FrameGate & { consent: 'browser' };
      /** Its status under the Trusted preset. dot.li never grants a browser-consented permission. */
      trusted: Exclude<PermissionStatus, 'granted'>;
    }
  | {
      /** Null where the core alone gates it. */
      frame: (FrameGate & { consent: 'dotli' }) | null;
      /** Its status under the Trusted preset. */
      trusted: PermissionStatus;
    }
);

/** Every permission a user can be asked for, in menu order. */
export const PERMISSION_CATALOG = {
  Notifications: {
    label: 'Notifications',
    group: 'device',
    description: 'Show in-app and system notifications',
    // Notifications has no directive, and its own prompt gates it with no iframe reload.
    frame: null,
    trusted: 'granted',
    browserCheck: 'notifications',
  },
  Camera: {
    label: 'Camera',
    group: 'device',
    description: 'Access your camera for photo and video capture',
    frame: { directive: 'camera', consent: 'browser' },
    trusted: 'ask',
    browserCheck: 'camera',
  },
  Microphone: {
    label: 'Microphone',
    group: 'device',
    description: 'Access your microphone for audio input',
    frame: { directive: 'microphone', consent: 'browser' },
    trusted: 'ask',
    browserCheck: 'microphone',
  },
  Location: {
    label: 'Location',
    group: 'device',
    description: 'Access your location for geolocation services',
    frame: { directive: 'geolocation', consent: 'browser' },
    trusted: 'ask',
    browserCheck: 'geolocation',
  },
  Motion: {
    label: 'Motion',
    group: 'device',
    description: "Read your device's motion and orientation sensors",
    // Device motion and orientation events need both sensors.
    frame: { directive: 'accelerometer; gyroscope', consent: 'browser' },
    trusted: 'ask',
    browserCheck: null,
  },
  Bluetooth: {
    label: 'Bluetooth',
    group: 'device',
    description: 'Connect to nearby Bluetooth devices',
    frame: { directive: 'bluetooth', consent: 'browser' },
    trusted: 'ask',
    browserCheck: null,
  },
  NFC: {
    label: 'NFC',
    group: 'device',
    description: 'Read and write nearby NFC tags',
    // Chromium-only, ignored elsewhere.
    frame: { directive: 'nfc', consent: 'dotli' },
    trusted: 'ask',
    browserCheck: null,
  },
  Clipboard: {
    label: 'Clipboard',
    group: 'device',
    description: 'Read text and data from your clipboard',
    // Write is always allowed, read needs consent.
    frame: { directive: 'clipboard-read', consent: 'browser' },
    trusted: 'ask',
    browserCheck: null,
  },
  Biometrics: {
    label: 'Biometrics',
    group: 'device',
    description: 'Authenticate with a platform passkey or biometric prompt',
    frame: { directive: 'publickey-credentials-get', consent: 'browser' },
    trusted: 'ask',
    browserCheck: null,
  },
  IdentityDisclosure: {
    label: 'Identity disclosure',
    group: 'app',
    description: 'Share your primary DotNS identity with this app',
    frame: null,
    trusted: 'granted',
    browserCheck: null,
  },
  ChainSubmit: {
    label: 'Sign transactions',
    group: 'app',
    description: 'Sign and submit network transactions on your behalf',
    frame: null,
    trusted: 'granted',
    browserCheck: null,
  },
  PreimageSubmit: {
    label: 'Submit preimages',
    group: 'app',
    description: 'Store preimage data on the Bulletin network',
    frame: null,
    trusted: 'granted',
    browserCheck: null,
  },
  StatementSubmit: {
    label: 'Submit statements',
    group: 'app',
    description: 'Submit signed statements to the statement store',
    frame: null,
    trusted: 'granted',
    browserCheck: null,
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

/** The iframe `allow` directive `name` gates, null where the core alone gates it. */
export function getFrameDirective(name: EnforceablePermissionName): string | null {
  return PERMISSION_CATALOG[name].frame?.directive ?? null;
}

/** The browser permission that reports `name`'s status, null where the browser reports none. */
export function getBrowserCheck(name: EnforceablePermissionName): BrowserCheck | null {
  return PERMISSION_CATALOG[name].browserCheck;
}

/** True when `name` has an iframe `allow` directive, so a change to it may rebuild the frame. */
export function hasFrameDirective(name: EnforceablePermissionName): boolean {
  return getFrameDirective(name) !== null;
}

/** True when the browser's own prompt is the consent to `name`, and dot.li only blocks it. */
export function isBrowserConsented(name: EnforceablePermissionName): boolean {
  return PERMISSION_CATALOG[name].frame?.consent === 'browser';
}

/**
 * True when `name` at `status` puts its directive in the frame's `allow` attribute: a browser-consented one unless
 * blocked, any other only once granted.
 */
export function isFrameDirectiveOn(name: EnforceablePermissionName, status: PermissionStatus): boolean {
  const { frame } = PERMISSION_CATALOG[name];
  if (frame === null) {
    return false;
  }
  switch (frame.consent) {
    case 'browser':
      return status !== 'denied';
    case 'dotli':
      return isPermissionGranted(status);
  }
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
