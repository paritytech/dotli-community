// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReadableStore } from '@dotli/shared';
import { useStore } from '@dotli/ui';
import type { EnforceablePermissionName, PermissionStatus } from '../runtime/permissions.js';
import type { MenuPermission, PermissionsNotice } from '../components/permissions/permissions.js';
import type { PermissionsItemProps } from '../components/permissions/PermissionsItem.js';

/** The product on show, as the panel reads it. */
export type ShownProduct =
  { status: 'none' } | { status: 'error' } | { status: 'loaded'; label: string; productId: string };

/** The product's permissions as last read or written, `statuses` in the order of the menu. */
export type ReadPermissions =
  | { status: 'none' }
  | { status: 'reading'; label: string }
  | { status: 'failed'; label: string }
  | { status: 'read'; label: string; statuses: readonly PermissionStatus[] };

/** The page's product and permissions, and the intents that change them. */
export interface PermissionsBinding {
  /** In menu order. */
  permissions: readonly MenuPermission[];
  product: ReadableStore<ShownProduct>;
  state: ReadableStore<ReadPermissions>;
  refresh: () => Promise<void>;
  choose: (label: string, name: EnforceablePermissionName, status: PermissionStatus) => Promise<void>;
  /** Every decided permission of `label` back to Ask. */
  reset: (label: string) => Promise<void>;
}

/** The permissions button's props, for an island's own lifetime. A change applies to the permissions last read. */
export function usePermissionsPanel(binding: PermissionsBinding): PermissionsItemProps {
  const product = useStore(binding.product);
  const state = useStore(binding.state);

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

  const statuses = (): readonly PermissionStatus[] | undefined => {
    const current = product();
    const read = state();
    return current.status === 'loaded' && read.status === 'read' && read.label === current.label
      ? read.statuses
      : undefined;
  };

  return {
    permissions: binding.permissions,
    hasGrants: useStore(binding.state, read => read.status === 'read' && read.statuses.includes('granted')),
    host: () => {
      const current = product();
      return current.status === 'loaded' ? current.productId : undefined;
    },
    notice,
    statuses,
    onOpen: () => {
      void binding.refresh();
    },
    onChoose: (name, next) => {
      const read = binding.state.get();
      if (read.status === 'read') {
        void binding.choose(read.label, name, next);
      }
    },
    onReset: () => {
      const read = binding.state.get();
      return read.status === 'read' ? binding.reset(read.label) : Promise.resolve();
    },
  };
}
