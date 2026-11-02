// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The Rust core owns and persists permission authorization. This side only maps granted device
// permissions to the iframe `allow` attribute.

import { getKeys } from '@dotli/shared';
import type {
  PermissionAuthorizationRequest,
  PermissionAuthorizationStatus,
  TrUApiProductProvider,
} from '@parity/truapi-host';
import {
  DEVICE_PERMISSION_POLICY,
  type DevicePermissionName,
  type PermissionName,
  type PermissionStatus,
} from './permissionPolicy.js';

export type PermissionAuthorizationProvider = Pick<
  TrUApiProductProvider,
  'getPermissionAuthorizationStatuses' | 'setPermissionAuthorizationStatus'
>;

/** Where a product's permissions are read and written: the core, through an open connection of that product. */
export type PermissionAuthorizations = ReturnType<typeof createPermissionAuthorizations>;

type SetStatusParams = {
  label: string;
  permission: PermissionName;
  status: PermissionStatus;
};

/**
 * Builds a registry with no connection registered. Its reads and writes reject when the core connection's call
 * rejects.
 */
export function createPermissionAuthorizations() {
  const providers = new Map<string, PermissionAuthorizationProvider[]>();

  function getProvider(label: string): PermissionAuthorizationProvider | null {
    return providers.get(label)?.at(-1) ?? null;
  }

  function register(label: string, provider: PermissionAuthorizationProvider): () => void {
    const registered = providers.get(label) ?? [];
    registered.push(provider);
    providers.set(label, registered);
    return unregister;

    function unregister(): void {
      const current = providers.get(label);
      const index = current?.lastIndexOf(provider) ?? -1;
      if (current === undefined || index < 0) {
        return;
      }
      current.splice(index, 1);
      if (current.length === 0) {
        providers.delete(label);
      }
    }
  }

  async function getStatuses(label: string, permissions: readonly PermissionName[]): Promise<PermissionStatus[]> {
    const provider = getProvider(label);
    if (provider === null) {
      return permissions.map(() => 'ask');
    }
    const answered = await provider.getPermissionAuthorizationStatuses(permissions.map(toAuthorizationRequest));
    return answered.map(fromAuthorizationStatus);
  }

  async function getStatus(label: string, permission: PermissionName): Promise<PermissionStatus> {
    return (await getStatuses(label, [permission])).at(0) ?? 'ask';
  }

  async function setStatus({ label, permission, status }: SetStatusParams): Promise<void> {
    const provider = getProvider(label);
    if (provider === null) {
      return;
    }
    await provider.setPermissionAuthorizationStatus(toAuthorizationRequest(permission), toAuthorizationStatus(status));
  }

  async function getGrantedDevicePermissions(label: string): Promise<DevicePermissionName[]> {
    const names = getKeys(DEVICE_PERMISSION_POLICY);
    const answered = await getStatuses(label, names);
    return names.filter((_, index) => answered[index] === 'granted');
  }

  async function getAllowAttribute(label: string): Promise<string> {
    // TrUAPI has no screen capture permission, and the browser's picker asks on every capture anyway.
    const policies = ['clipboard-write', 'display-capture'];
    for (const name of await getGrantedDevicePermissions(label)) {
      const directive = DEVICE_PERMISSION_POLICY[name];
      if (directive !== undefined) {
        policies.push(directive);
      }
    }
    return policies.join('; ');
  }

  return {
    /**
     * Routes `label`'s permissions through `provider` until the returned unregister. The newest connection answers, as
     * a render on a replacement core registers last. Never throws, and the unregister is idempotent.
     */
    register,
    /** `label`'s status of each of `permissions`, `ask` for each while no connection of `label` is open. */
    getStatuses,
    /** `label`'s status of `permission`, `ask` while no connection of `label` is open. */
    getStatus,
    /** Sets `label`'s status of `permission`. A no-op while no connection of `label` is open. */
    setStatus,
    /** The device permissions `label` was granted, none while no connection of `label` is open. */
    getGrantedDevicePermissions,
    /** The iframe `allow` attribute for `label`'s granted device permissions, plus those every product gets. */
    getAllowAttribute,
  };
}

function toAuthorizationRequest(permission: PermissionName): PermissionAuthorizationRequest {
  switch (permission) {
    case 'ChainSubmit':
    case 'PreimageSubmit':
    case 'StatementSubmit':
      return {
        tag: 'Remote',
        value: { permission: { tag: permission } },
      };
    case 'IdentityDisclosure':
      return { tag: 'IdentityDisclosure' };
    case 'Notifications':
    case 'Camera':
    case 'Microphone':
    case 'Bluetooth':
    case 'NFC':
    case 'Location':
    case 'Clipboard':
    case 'OpenUrl':
    case 'Biometrics':
      return { tag: 'Device', value: permission };
  }
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
