// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Permission authorization
//
// Permission authorization is owned by the Rust core and persisted through
// CoreStorage. Web dotli only maps authorized device permissions to browser
// iframe policy directives.
// Device permissions that map to a Permissions Policy directive also
// gate the iframe `allow` attribute (granting or revoking reloads the
// iframe). Variants without a directive are policy-only.
//
// Permission status: 'ask' (default), 'granted', or 'denied'.

import type { HostDevicePermissionRequest } from '@parity/truapi';
import type {
  PermissionAuthorizationRequest,
  PermissionAuthorizationStatus,
  TrUApiProductProvider,
} from '@parity/truapi-host';

export type DevicePermissionName = HostDevicePermissionRequest;

export type PermissionName =
  DevicePermissionName | 'ChainSubmit' | 'IdentityDisclosure' | 'PreimageSubmit' | 'StatementSubmit';

/** Device permissions the host can't actually gate (see AUTO_GRANT_DEVICE_PERMISSIONS). */
export type AutoGrantDevicePermission = 'OpenUrl';

/** Device permissions that DO have a host-side enforcement point. */
export type EnforceableDevicePermission = Exclude<DevicePermissionName, AutoGrantDevicePermission>;

/** Permissions the host actually surfaces to the user (popover + modal). */
export type EnforceablePermissionName = Exclude<PermissionName, AutoGrantDevicePermission>;

export type PermissionStatus = 'ask' | 'granted' | 'denied';

/**
 * Map from Host API device permission names to Permissions Policy directives.
 *
 * Only variants with a browser-level enforcement point are listed. Authorizing
 * a variant absent from this map is still persisted by the core but does not
 * alter the iframe `allow` attribute.
 */
export const DEVICE_PERMISSION_POLICY: Partial<Record<DevicePermissionName, string>> = {
  Camera: 'camera',
  Microphone: 'microphone',
  Location: 'geolocation',
  Bluetooth: 'bluetooth',
  // Clipboard write is always granted by dot.li (see buildAllowAttribute).
  // The read directive requires explicit consent.
  Clipboard: 'clipboard-read',
  // WebAuthn directive covering the Biometrics variant for hosts that expose
  // it via passkeys or platform authenticators.
  Biometrics: 'publickey-credentials-get',
  // Chromium-only. Harmless to include on browsers that ignore it.
  NFC: 'nfc',
  // Notifications has no Permissions Policy directive but IS host-gated
  // separately in handleDevicePermission (tri-state, no iframe reload).
  // OpenUrl: cross-origin navigation happens via anchor / window.open.
};

/**
 * Device permissions whose enforcement is outside the host's reach.
 *
 * Currently only OpenUrl. Cross-origin navigation happens via anchor or
 * window.open and has no host-side enforcement point. Requests for it
 * always resolve `true` and it is hidden from the settings popover.
 * Offering a control that can't actually block would mislead users.
 */
export const AUTO_GRANT_DEVICE_PERMISSIONS: ReadonlySet<AutoGrantDevicePermission> = new Set<AutoGrantDevicePermission>(
  ['OpenUrl'],
);

/** Type guard: narrows `DevicePermissionName` past the auto-grant set. */
export function isEnforceableDevicePermission(name: DevicePermissionName): name is EnforceableDevicePermission {
  return !(AUTO_GRANT_DEVICE_PERMISSIONS as ReadonlySet<string>).has(name);
}

/**
 * Where a permission sits in the menu: what the device lets the app use, or
 * what the app does with the user's account and the network.
 */
export type PermissionGroup = 'device' | 'app';

/** All permissions shown in the topbar menu, in display order. */
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

/** Returns true if the permission name maps to an iframe `allow` directive. */
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
  if (permission === 'IdentityDisclosure') {
    return { tag: 'IdentityDisclosure' };
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
    return;
  }
  await provider.setPermissionAuthorizationStatus(authorizationRequest(permission), toAuthorizationStatus(status));
}

export async function resetPermission(label: string, permission: PermissionName): Promise<void> {
  await setPermissionStatus(label, permission, 'ask');
}

/** What resetAllPermissions changed. */
export interface ResetAllResult {
  /** The permissions set back to ask, in menu order. */
  reset: EnforceablePermissionName[];
  /** Whether any write failed. Those permissions keep their status. */
  failed: boolean;
}

/**
 * Set every granted or denied permission of `label` back to ask.
 *
 * The writes run together and each may fail on its own, so the caller learns
 * which ones landed and can announce them as one change. A status read that
 * fails rejects, before anything is written.
 */
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

/** Returns the list of device permission names that have been granted. */
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

/** Returns true if any permission (device or remote) is granted. */
export async function hasAnyGrant(label: string): Promise<boolean> {
  const statuses = await getPermissionStatuses(
    label,
    ALL_PERMISSIONS.map(({ name }) => name),
  );
  return statuses.some(status => status === 'granted');
}

/**
 * Build the iframe `allow` attribute value from granted device permissions.
 * Always includes `clipboard-write`; adds Permissions Policy directives
 * for each granted device permission.
 */
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
