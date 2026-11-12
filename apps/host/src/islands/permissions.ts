// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReadableAtom } from 'nanostores';
import { useStore } from '@dotli/stores-solid';
import type { PermissionTargets } from '../runtime/permissionPolicy.js';
import {
  getRead,
  hasGrant,
  isUnreadable,
  type PermissionsRead,
  type ProductPermissionsState,
  type ProductPermissions,
} from '../runtime/state/productPermissions.js';
import type { PermissionsNotice } from '../components/permissions/permissions.js';
import type { PermissionsContentProps } from '../components/permissions/PermissionsContent.js';
import type { PermissionsItemProps } from '../components/permissions/PermissionsItem.js';

const INITIAL_STATE: ProductPermissionsState = { status: 'none' };

/** The product on show, as the panel reads it. */
export type ShownProduct = { status: 'none' } | { status: 'error' } | { status: 'loaded'; label: string };

/** The page's product and permissions, and the intents that change them. */
export type PermissionsBinding = {
  permissions: PermissionsContentProps['permissions'];
  product: ReadableAtom<ShownProduct>;
  /** The product's permissions as last read or written, and the intents that change them. */
  store: Pick<ProductPermissions, 'state' | 'pending' | 'refresh' | 'change'>;
};

/** The permissions button's props, for an island's own lifetime. A change applies to the permissions last read. */
export function usePermissionsPanel(binding: PermissionsBinding): PermissionsItemProps {
  const product = useStore(binding.product);
  const state = useStore(binding.store.state, { initial: INITIAL_STATE });
  const pendingChange = useStore(binding.store.pending, { initial: null });

  const notice = (): PermissionsNotice | undefined => {
    const current = product();
    if (current.status === 'none') {
      return 'loading';
    }
    if (current.status === 'error') {
      return 'no-app';
    }
    return isUnreadable(state(), current.label) ? 'unavailable' : undefined;
  };

  const shownRead = (): PermissionsRead | undefined => {
    const current = product();
    const read = getRead(state());
    return current.status === 'loaded' && read?.label === current.label ? read : undefined;
  };

  // A pending change of another app, such as the one shown before, says nothing about this one.
  const pendingTargets = (): PermissionTargets | undefined => {
    const read = shownRead();
    const change = pendingChange();
    return read !== undefined && change !== null && change.label === read.label ? change.targets : undefined;
  };

  return {
    permissions: binding.permissions,
    hasGrants: useStore(binding.store.state, hasGrant, { initial: INITIAL_STATE }),
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
      void binding.store.refresh();
    },
    onChange: async targets => {
      const read = getRead(binding.store.state.get());
      return read === undefined ? [] : (await binding.store.change(read.label, targets)).failed;
    },
  };
}
