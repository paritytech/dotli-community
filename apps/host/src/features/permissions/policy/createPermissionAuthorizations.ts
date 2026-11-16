// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The Rust core owns and persists permission authorization. This side routes each product's reads and writes to the
// newest open connection of that product, and maps its device permissions to the iframe `allow` attribute.

import type { PermissionAuthorizationStatus, TrUApiProductProvider } from '@parity/truapi-host';
import {
  ALL_PERMISSIONS,
  getAuthorizationRequest,
  getFrameDirective,
  hasFrameDirective,
  isBrowserConsented,
  isFrameDirectiveOn,
  type EnforceablePermissionName,
  type PermissionStatus,
} from './permissionPolicy.js';

type PermissionAuthorizationProvider = Pick<
  TrUApiProductProvider,
  'getPermissionAuthorizationStatuses' | 'setPermissionAuthorizationStatus'
>;

/** Where a product's permissions are read and written: the core, through an open connection of that product. */
export type PermissionAuthorizations = ReturnType<typeof createPermissionAuthorizations>;

type SetStatusParams = {
  label: string;
  permission: EnforceablePermissionName;
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
      if (current === undefined) {
        return;
      }
      const index = current.lastIndexOf(provider);
      if (index < 0) {
        return;
      }
      current.splice(index, 1);
      if (current.length === 0) {
        providers.delete(label);
      }
    }
  }

  async function getStatuses(
    label: string,
    permissions: readonly EnforceablePermissionName[],
  ): Promise<PermissionStatus[]> {
    const provider = getProvider(label);
    if (provider === null) {
      return permissions.map(() => 'ask');
    }
    const answered = await provider.getPermissionAuthorizationStatuses(permissions.map(getAuthorizationRequest));
    return permissions.map((name, index) => {
      const status = answered.at(index);
      return status === undefined ? 'ask' : fromAuthorizationStatus(name, status);
    });
  }

  async function getStatus(label: string, permission: EnforceablePermissionName): Promise<PermissionStatus> {
    return (await getStatuses(label, [permission])).at(0) ?? 'ask';
  }

  async function setStatus({ label, permission, status }: SetStatusParams): Promise<void> {
    const provider = getProvider(label);
    if (provider === null) {
      return;
    }
    await provider.setPermissionAuthorizationStatus(getAuthorizationRequest(permission), toAuthorizationStatus(status));
  }

  async function getFramePermissions(label: string): Promise<EnforceablePermissionName[]> {
    const names = ALL_PERMISSIONS.map(({ name }) => name).filter(hasFrameDirective);
    const answered = await getStatuses(label, names);
    return names.filter((name, index) => isFrameDirectiveOn(name, answered[index] ?? 'ask'));
  }

  async function getAllowAttribute(label: string): Promise<string> {
    // TrUAPI has no screen capture permission, and the browser's picker asks on every capture anyway.
    const directives = (await getFramePermissions(label)).flatMap(name => getFrameDirective(name) ?? []);
    return ['clipboard-write', 'display-capture', ...directives].join('; ');
  }

  return {
    /**
     * Routes `label`'s permissions through `provider` until the returned unregister. The newest connection answers, as
     * a render on a replacement core registers last. Never throws, and the unregister is idempotent.
     */
    register,
    /**
     * `label`'s status of each of `permissions`, `ask` for each while no connection of `label` is open. A
     * browser-consented permission an earlier version granted reads `ask`, which is what that grant means now.
     */
    getStatuses,
    /** `label`'s status of `permission`, `ask` while no connection of `label` is open. */
    getStatus,
    /** Sets `label`'s status of `permission`. A no-op while no connection of `label` is open. */
    setStatus,
    /** The permissions whose directive `label`'s statuses put in the frame, as with no connection open. */
    getFramePermissions,
    /** The iframe `allow` attribute for `label`'s device permissions, plus the directives every product gets. */
    getAllowAttribute,
  };
}

function fromAuthorizationStatus(
  name: EnforceablePermissionName,
  status: PermissionAuthorizationStatus,
): PermissionStatus {
  switch (status) {
    case 'Authorized':
      return isBrowserConsented(name) ? 'ask' : 'granted';
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
