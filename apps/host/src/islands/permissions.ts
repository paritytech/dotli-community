// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReadableStore } from '@dotli/shared';
import { useStore } from '@dotli/ui';
import type { PermissionStatus, PermissionTargets } from '../runtime/permissions.js';
import type { ChangeOutcome, PendingPermissions } from '../runtime/state/product-permissions.js';
import type { MenuPermission, PermissionsNotice } from '../components/permissions/permissions.js';
import type { PermissionsItemProps } from '../components/permissions/PermissionsItem.js';

/** The product on show, as the panel reads it. */
export type ShownProduct = { status: 'none' } | { status: 'error' } | { status: 'loaded'; label: string };

/** The product's permissions as last read or written, `statuses` in the order of the menu. */
export type ReadPermissions =
  | { status: 'none' }
  | { status: 'reading'; label: string }
  | { status: 'failed'; label: string }
  | { status: 'read'; label: string; statuses: readonly PermissionStatus[] };

/** The page's product and permissions, and the intents that change them. */
export type PermissionsBinding = {
  /** In menu order. */
  permissions: readonly MenuPermission[];
  product: ReadableStore<ShownProduct>;
  state: ReadableStore<ReadPermissions>;
  /** The panel change not yet settled. */
  pending: ReadableStore<PendingPermissions>;
  refresh: () => Promise<void>;
  change: (label: string, targets: PermissionTargets) => Promise<ChangeOutcome>;
};

/** The permissions button's props, for an island's own lifetime. A change applies to the permissions last read. */
export function usePermissionsPanel(binding: PermissionsBinding): PermissionsItemProps {
  const product = useStore(binding.product);
  const state = useStore(binding.state);
  const pendingChange = useStore(binding.pending);

  const notice = (): PermissionsNotice | undefined => {
    const current = product();
    if (current.status === 'none') {
      return 'loading';
    }
    if (current.status === 'error') {
      return 'no-app';
    }
    const read = state();
    return read.status === 'failed' && read.label === current.label ? 'unavailable' : undefined;
  };

  const shownRead = (): { label: string; statuses: readonly PermissionStatus[] } | undefined => {
    const current = product();
    const read = state();
    return current.status === 'loaded' && read.status === 'read' && read.label === current.label ? read : undefined;
  };

  // A pending change of another app, such as the one shown before, says nothing about this one.
  const pendingTargets = (): PermissionTargets | undefined => {
    const read = shownRead();
    const change = pendingChange();
    return read !== undefined && change !== null && change.label === read.label ? change.targets : undefined;
  };

  return {
    permissions: binding.permissions,
    hasGrants: useStore(binding.state, read => read.status === 'read' && read.statuses.includes('granted')),
    notice,
    statuses: () => {
      const read = shownRead();
      const targets = pendingTargets();
      if (read === undefined || targets === undefined) {
        return read?.statuses;
      }
      return read.statuses.map((status, i) => {
        const name = binding.permissions[i]?.name;
        return name === undefined ? status : (targets[name] ?? status);
      });
    },
    pending: () => pendingTargets() !== undefined,
    onOpen: () => {
      void binding.refresh();
    },
    onChange: async targets => {
      const read = binding.state.get();
      return read.status === 'read' ? (await binding.change(read.label, targets)).failed : [];
    },
  };
}
