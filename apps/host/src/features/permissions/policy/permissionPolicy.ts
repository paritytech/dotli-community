// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The permissions a product can hold, with each one's facts in one table.

import { getKeys } from '@dotli/shared';
import type { HostDevicePermissionRequest } from '@parity/truapi';
import type { PermissionAuthorizationRequest } from '@parity/truapi-host';

export type PermissionName =
  HostDevicePermissionRequest | 'ChainSubmit' | 'IdentityDisclosure' | 'PreimageSubmit' | 'StatementSubmit';

/**
 * The permissions dot.li does not support. They stay out of the menu, the presets and the frame, and a product that asks
 * for one is denied. NFC's browser API cannot run in a frame.
 */
type UnsupportedPermission = 'NFC';

const UNSUPPORTED_PERMISSIONS: ReadonlySet<PermissionName> = new Set<UnsupportedPermission>(['NFC']);

/**
 * Navigation has no host-side enforcement point, so the menu leaves it out, where a control that cannot block would
 * mislead.
 */
type AutoGrantDevicePermission = 'OpenUrl';

export type EnforceablePermissionName = Exclude<PermissionName, AutoGrantDevicePermission | UnsupportedPermission>;

/** True when dot.li does not support `name`. */
export function isUnsupportedPermission(name: PermissionName): name is UnsupportedPermission {
  return UNSUPPORTED_PERMISSIONS.has(name);
}

/** True when dot.li grants `name` at once, with no menu control and no dialog. */
export function isAutoGrantPermission(name: PermissionName): name is AutoGrantDevicePermission {
  return name === 'OpenUrl';
}

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
      /**
       * The iframe `allow` directive it gates. The browser's own prompt is the consent, as on any website, so the
       * directive is in unless dot.li blocks it.
       */
      directive: string;
      /** Its status under the Trusted preset. dot.li never grants a browser-consented permission. */
      trusted: Exclude<PermissionStatus, 'granted'>;
    }
  | {
      /** Null, as the core alone gates it. */
      directive: null;
      /** Its status under the Trusted preset. */
      trusted: PermissionStatus;
    }
);

/** Every permission a user can be asked for, in menu order. */
export const PERMISSION_CATALOG = {
  Camera: {
    label: 'Camera',
    group: 'device',
    description: 'Access your camera for photo and video capture',
    directive: 'camera',
    trusted: 'ask',
    browserCheck: 'camera',
  },
  Microphone: {
    label: 'Microphone',
    group: 'device',
    description: 'Access your microphone for audio input',
    directive: 'microphone',
    trusted: 'ask',
    browserCheck: 'microphone',
  },
  Location: {
    label: 'Location',
    group: 'device',
    description: 'Access your location for geolocation services',
    directive: 'geolocation',
    trusted: 'ask',
    browserCheck: 'geolocation',
  },
  Motion: {
    label: 'Motion',
    group: 'device',
    description: "Read your device's motion and orientation sensors",
    // Device motion and orientation events need both sensors.
    directive: 'accelerometer; gyroscope',
    trusted: 'ask',
    browserCheck: null,
  },
  Bluetooth: {
    label: 'Bluetooth',
    group: 'device',
    description: 'Connect to nearby Bluetooth devices',
    directive: 'bluetooth',
    trusted: 'ask',
    browserCheck: null,
  },
  Clipboard: {
    label: 'Clipboard',
    group: 'device',
    description: 'Read text and data from your clipboard',
    // Write is always allowed, read needs consent.
    directive: 'clipboard-read',
    trusted: 'ask',
    browserCheck: null,
  },
  Biometrics: {
    label: 'Biometrics',
    group: 'device',
    description: 'Authenticate with a platform passkey or biometric prompt',
    directive: 'publickey-credentials-get',
    trusted: 'ask',
    browserCheck: null,
  },
  Notifications: {
    label: 'Notifications',
    group: 'device',
    description: 'Show in-app and system notifications',
    // Notifications has no directive, and its own prompt gates it.
    directive: null,
    trusted: 'granted',
    browserCheck: 'notifications',
  },
  IdentityDisclosure: {
    label: 'Identity disclosure',
    group: 'app',
    description: 'Share your primary DotNS identity with this app',
    directive: null,
    trusted: 'granted',
    browserCheck: null,
  },
  ChainSubmit: {
    label: 'Sign transactions',
    group: 'app',
    description: 'Sign and submit network transactions on your behalf',
    directive: null,
    trusted: 'granted',
    browserCheck: null,
  },
  PreimageSubmit: {
    label: 'Submit preimages',
    group: 'app',
    description: 'Store preimage data on the Bulletin network',
    directive: null,
    trusted: 'granted',
    browserCheck: null,
  },
  StatementSubmit: {
    label: 'Submit statements',
    group: 'app',
    description: 'Submit signed statements to the statement store',
    directive: null,
    trusted: 'granted',
    browserCheck: null,
  },
} satisfies Record<EnforceablePermissionName, PermissionFacts>;

/** Each menu group's heading, in menu order. */
export const PERMISSION_GROUPS = {
  device: { label: 'Device' },
  app: { label: 'Account and chain' },
} satisfies Record<PermissionGroup, { label: string }>;

/** Every permission a user can be asked for, in menu order. */
export const PERMISSION_NAMES: readonly EnforceablePermissionName[] = getKeys(PERMISSION_CATALOG);

/** In menu display order. */
export const ALL_PERMISSIONS: readonly {
  name: EnforceablePermissionName;
  label: string;
  group: PermissionGroup;
}[] = PERMISSION_NAMES.map(name => ({
  name,
  label: PERMISSION_CATALOG[name].label,
  group: PERMISSION_CATALOG[name].group,
}));

/** The iframe `allow` directive `name` gates, null where the core alone gates it. */
export function getFrameDirective(name: EnforceablePermissionName): string | null {
  return PERMISSION_CATALOG[name].directive;
}

/** The browser permission that reports `name`'s status, null where the browser reports none. */
export function getBrowserCheck(name: EnforceablePermissionName): BrowserCheck | null {
  return PERMISSION_CATALOG[name].browserCheck;
}

/** True when `name` has an iframe `allow` directive, whose consent is the browser's own prompt, so dot.li only blocks it. */
export function isBrowserConsented(name: EnforceablePermissionName): boolean {
  return getFrameDirective(name) !== null;
}

/** True when `name` at `status` puts its directive in the frame's `allow` attribute, which is unless it is blocked. */
export function isFrameDirectiveOn(name: EnforceablePermissionName, status: PermissionStatus): boolean {
  return isBrowserConsented(name) && status !== 'denied';
}

/** The core's request for `name`. */
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
    case 'Location':
    case 'Motion':
    case 'Clipboard':
    case 'Biometrics':
      return { tag: 'Device', value: name };
  }
}

/** True when the core asks for `name` as a remote permission, one for what the app does on the network. */
export function isRemotePermission(name: EnforceablePermissionName): boolean {
  return getAuthorizationRequest(name).tag === 'Remote';
}
