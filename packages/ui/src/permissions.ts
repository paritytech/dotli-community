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
  | DevicePermissionName
  | 'ChainSubmit'
  | 'ChatAuthority'
  | 'IdentityDisclosure'
  | 'PreimageSubmit'
  | 'ProfileDisclosure'
  | 'StatementSubmit';

export type AutoGrantDevicePermission = 'OpenUrl';

export type EnforceableDevicePermission = Exclude<DevicePermissionName, AutoGrantDevicePermission>;

export type EnforceablePermissionName = Exclude<PermissionName, AutoGrantDevicePermission>;

export type PermissionStatus = 'ask' | 'granted' | 'denied';

/** A variant absent here is still persisted by the core but leaves the iframe `allow` attribute alone. */
export const DEVICE_PERMISSION_POLICY: Partial<Record<DevicePermissionName, string>> = {
  Camera: 'camera',
  Microphone: 'microphone',
  Location: 'geolocation',
  Bluetooth: 'bluetooth',
  // Write is always allowed (buildAllowAttribute), read needs consent.
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
  { name: 'ChatAuthority', label: 'Chat identity authority', group: 'app' },
  { name: 'IdentityDisclosure', label: 'Identity disclosure', group: 'app' },
  { name: 'ProfileDisclosure', label: 'Profile disclosure', group: 'app' },
  { name: 'ChainSubmit', label: 'Sign transactions', group: 'app' },
  { name: 'PreimageSubmit', label: 'Submit preimages', group: 'app' },
  { name: 'StatementSubmit', label: 'Submit statements', group: 'app' },
];

/** True when the permission maps to an iframe `allow` directive. */
export function isDevicePermission(name: string): boolean {
  return name in DEVICE_PERMISSION_POLICY;
}

type PermissionAuthorizationProvider = Pick<
  TrUApiProductProvider,
  'getPermissionAuthorizationStatuses' | 'setPermissionAuthorizationStatus'
>;

const permissionProviders = new Map<string, PermissionAuthorizationProvider[]>();

export function registerPermissionAuthorizationProvider(
  label: string,
  provider: PermissionAuthorizationProvider,
): () => void {
  const providers = permissionProviders.get(label) ?? [];
  providers.push(provider);
  permissionProviders.set(label, providers);
  return () => {
    const registered = permissionProviders.get(label);
    if (registered === undefined) {
      return;
    }
    const index = registered.lastIndexOf(provider);
    if (index >= 0) {
      registered.splice(index, 1);
    }
    if (registered.length === 0) {
      permissionProviders.delete(label);
    }
  };
}

function providerFor(label: string): PermissionAuthorizationProvider | null {
  return permissionProviders.get(label)?.at(-1) ?? null;
}

export function authorizationRequest(permission: PermissionName): PermissionAuthorizationRequest {
  if (permission === 'ChainSubmit' || permission === 'PreimageSubmit' || permission === 'StatementSubmit') {
    return {
      tag: 'Remote',
      value: { permission: { tag: permission } },
    };
  }
  if (permission === 'ChatAuthority') {
    return { tag: 'ChatAuthority' };
  }
  if (permission === 'IdentityDisclosure') {
    return { tag: 'IdentityDisclosure' };
  }
  if (permission === 'ProfileDisclosure') {
    return { tag: 'ProfileDisclosure' };
  }
  return { tag: 'Device', value: permission };
}

export function fromAuthorizationStatus(status: PermissionAuthorizationStatus): PermissionStatus {
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

export async function getPermissionStatus(label: string, permission: PermissionName): Promise<PermissionStatus> {
  const statuses = await getPermissionStatuses(label, [permission]);
  return statuses.at(0) ?? 'ask';
}

export async function getPermissionStatuses(
  label: string,
  permissions: readonly PermissionName[],
): Promise<PermissionStatus[]> {
  const provider = providerFor(label);
  if (provider === null) {
    return permissions.map(() => 'ask');
  }
  const statuses = await provider.getPermissionAuthorizationStatuses(permissions.map(authorizationRequest));
  return statuses.map(fromAuthorizationStatus);
}

export async function setPermissionStatus(
  label: string,
  permission: PermissionName,
  status: PermissionStatus,
): Promise<void> {
  const provider = providerFor(label);
  if (provider === null) {
    throw new Error('product connection is unavailable');
  }
  await provider.setPermissionAuthorizationStatus(authorizationRequest(permission), toAuthorizationStatus(status));
}

export async function resetPermission(label: string, permission: PermissionName): Promise<void> {
  await setPermissionStatus(label, permission, 'ask');
}

export interface ResetAllResult {
  /** In menu order. */
  reset: EnforceablePermissionName[];
  /** Failed permissions keep their status. */
  failed: boolean;
}

/** Each write may fail on its own, so the caller learns which landed and can announce them as one change. */
export async function resetAllPermissions(label: string): Promise<ResetAllResult> {
  const names = ALL_PERMISSIONS.map(({ name }) => name);
  const statuses = await getPermissionStatuses(label, names);
  const decided = names.filter((_, index) => (statuses[index] ?? 'ask') !== 'ask');
  const writes = await Promise.allSettled(decided.map(name => setPermissionStatus(label, name, 'ask')));
  return {
    reset: decided.filter((_, index) => writes[index]?.status === 'fulfilled'),
    failed: writes.some(write => write.status === 'rejected'),
  };
}

export async function getGrantedDevicePermissions(label: string): Promise<DevicePermissionName[]> {
  const granted: DevicePermissionName[] = [];
  const names = Object.keys(DEVICE_PERMISSION_POLICY) as DevicePermissionName[];
  const statuses = await getPermissionStatuses(label, names);
  for (const [index, name] of names.entries()) {
    if (statuses[index] === 'granted') {
      granted.push(name);
    }
  }
  return granted;
}

export async function hasAnyGrant(label: string): Promise<boolean> {
  const statuses = await getPermissionStatuses(
    label,
    ALL_PERMISSIONS.map(({ name }) => name),
  );
  return statuses.some(status => status === 'granted');
}

export async function buildAllowAttribute(label: string): Promise<string> {
  const policies = ['clipboard-write'];
  for (const name of await getGrantedDevicePermissions(label)) {
    const directive = DEVICE_PERMISSION_POLICY[name];
    if (directive !== undefined) {
      policies.push(directive);
    }
  }
  return policies.join('; ');
}
