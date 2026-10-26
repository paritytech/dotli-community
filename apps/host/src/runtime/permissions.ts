// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The Rust core owns and persists permission authorization. This side only maps granted device
// permissions to the iframe `allow` attribute.

import type { HostDevicePermissionRequest } from '@parity/truapi';
import type {
  PermissionAuthorizationRequest,
  PermissionAuthorizationStatus,
  TrUApiProductProvider,
} from '@parity/truapi-host';

export type DevicePermissionName = HostDevicePermissionRequest;

export type PermissionName =
  DevicePermissionName | 'ChainSubmit' | 'IdentityDisclosure' | 'PreimageSubmit' | 'StatementSubmit';

export type AutoGrantDevicePermission = 'OpenUrl';

export type EnforceableDevicePermission = Exclude<DevicePermissionName, AutoGrantDevicePermission>;

export type EnforceablePermissionName = Exclude<PermissionName, AutoGrantDevicePermission>;

export type PermissionStatus = 'ask' | 'granted' | 'denied';

/** Statuses for some of an app's permissions, as one change writes them. */
export type PermissionTargets = Readonly<Partial<Record<EnforceablePermissionName, PermissionStatus>>>;

/** A variant absent here is still persisted by the core but leaves the iframe `allow` attribute alone. */
export const DEVICE_PERMISSION_POLICY: Partial<Record<DevicePermissionName, string>> = {
  Camera: 'camera',
  Microphone: 'microphone',
  Location: 'geolocation',
  Bluetooth: 'bluetooth',
  // Write is always allowed (allowAttribute), read needs consent.
  Clipboard: 'clipboard-read',
  Biometrics: 'publickey-credentials-get',
  // Chromium-only, ignored elsewhere.
  NFC: 'nfc',
  // Notifications has no directive but is gated in handleDevicePermission, with no iframe reload.
};

/**
 * Navigation via anchor or window.open has no host-side enforcement point, so these always resolve
 * `true` and stay out of the menu, where a control that cannot block would mislead.
 */
export const AUTO_GRANT_DEVICE_PERMISSIONS: ReadonlySet<AutoGrantDevicePermission> = new Set<AutoGrantDevicePermission>(
  ['OpenUrl'],
);

export function isEnforceableDevicePermission(name: DevicePermissionName): name is EnforceableDevicePermission {
  return !(AUTO_GRANT_DEVICE_PERMISSIONS as ReadonlySet<string>).has(name);
}

/** What the device lets the app use, or what the app does with the account and the network. */
export type PermissionGroup = 'device' | 'app';

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
  { name: 'Bluetooth', label: 'Bluetooth', group: 'device' },
  { name: 'NFC', label: 'NFC', group: 'device' },
  { name: 'Clipboard', label: 'Clipboard', group: 'device' },
  { name: 'Biometrics', label: 'Biometrics', group: 'device' },
  { name: 'IdentityDisclosure', label: 'Identity disclosure', group: 'app' },
  { name: 'ChainSubmit', label: 'Sign transactions', group: 'app' },
  { name: 'PreimageSubmit', label: 'Submit preimages', group: 'app' },
  { name: 'StatementSubmit', label: 'Submit statements', group: 'app' },
];

/** True when the permission maps to an iframe `allow` directive. */
export function isDevicePermission(name: string): boolean {
  return name in DEVICE_PERMISSION_POLICY;
}

export type PermissionAuthorizationProvider = Pick<
  TrUApiProductProvider,
  'getPermissionAuthorizationStatuses' | 'setPermissionAuthorizationStatus'
>;

/** Where a product's permissions are read and written: the core, through an open connection of that product. */
export type PermissionAuthorizations = {
  /**
   * Routes `label`'s permissions through `provider` until the returned unregister. The newest connection answers, as a
   * render on a replacement core registers last.
   */
  register(label: string, provider: PermissionAuthorizationProvider): () => void;
  /** `ask` for each while no connection of `label` is open. */
  statuses(label: string, permissions: readonly PermissionName[]): Promise<PermissionStatus[]>;
  status(label: string, permission: PermissionName): Promise<PermissionStatus>;
  /** A no-op while no connection of `label` is open. */
  setStatus(label: string, permission: PermissionName, status: PermissionStatus): Promise<void>;
  grantedDevicePermissions(label: string): Promise<DevicePermissionName[]>;
  /** The iframe `allow` attribute for `label`'s granted device permissions, plus those every product gets. */
  allowAttribute(label: string): Promise<string>;
};

function authorizationRequest(permission: PermissionName): PermissionAuthorizationRequest {
  if (permission === 'ChainSubmit' || permission === 'PreimageSubmit' || permission === 'StatementSubmit') {
    return {
      tag: 'Remote',
      value: { permission: { tag: permission } },
    };
  }
  if (permission === 'IdentityDisclosure') {
    return { tag: 'IdentityDisclosure' };
  }
  return { tag: 'Device', value: permission };
}

function fromAuthorizationStatus(status: PermissionAuthorizationStatus): PermissionStatus {
  switch (status) {
    case 'Authorized':
      return 'granted';
    case 'Denied':
      return 'denied';
    case 'NotDetermined':
      return 'ask';
  }
}

function toAuthorizationStatus(status: PermissionStatus): PermissionAuthorizationStatus {
  switch (status) {
    case 'granted':
      return 'Authorized';
    case 'denied':
      return 'Denied';
    case 'ask':
      return 'NotDetermined';
  }
}

export function createPermissionAuthorizations(): PermissionAuthorizations {
  const providers = new Map<string, PermissionAuthorizationProvider[]>();
  const providerFor = (label: string): PermissionAuthorizationProvider | null => providers.get(label)?.at(-1) ?? null;

  const statuses = async (label: string, permissions: readonly PermissionName[]): Promise<PermissionStatus[]> => {
    const provider = providerFor(label);
    if (provider === null) {
      return permissions.map(() => 'ask');
    }
    const answered = await provider.getPermissionAuthorizationStatuses(permissions.map(authorizationRequest));
    return answered.map(fromAuthorizationStatus);
  };

  const setStatus = async (label: string, permission: PermissionName, status: PermissionStatus): Promise<void> => {
    const provider = providerFor(label);
    if (provider === null) {
      return;
    }
    await provider.setPermissionAuthorizationStatus(authorizationRequest(permission), toAuthorizationStatus(status));
  };

  const grantedDevicePermissions = async (label: string): Promise<DevicePermissionName[]> => {
    const names = Object.keys(DEVICE_PERMISSION_POLICY) as DevicePermissionName[];
    const answered = await statuses(label, names);
    return names.filter((_, index) => answered[index] === 'granted');
  };

  return {
    register(label, provider) {
      const registered = providers.get(label) ?? [];
      registered.push(provider);
      providers.set(label, registered);
      return () => {
        const current = providers.get(label);
        const index = current?.lastIndexOf(provider) ?? -1;
        if (current === undefined || index < 0) {
          return;
        }
        current.splice(index, 1);
        if (current.length === 0) {
          providers.delete(label);
        }
      };
    },
    statuses,
    status: async (label, permission) => (await statuses(label, [permission])).at(0) ?? 'ask',
    setStatus,
    grantedDevicePermissions,
    async allowAttribute(label) {
      // TrUAPI has no screen capture permission, and the browser's picker asks on every capture anyway.
      const policies = ['clipboard-write', 'display-capture'];
      for (const name of await grantedDevicePermissions(label)) {
        const directive = DEVICE_PERMISSION_POLICY[name];
        if (directive !== undefined) {
          policies.push(directive);
        }
      }
      return policies.join('; ');
    },
  };
}
