// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { ALL_PERMISSIONS } from '../runtime/permissions.js';
import {
  chooseProductPermission,
  productPermissionsStore,
  refreshProductPermissions,
  resetProductPermissions,
} from '../runtime/state/product-permissions.js';
import { productStore } from '../runtime/state/product.js';
import { PermissionsItem } from '../components/permissions/PermissionsItem.js';
import { usePermissionsPanel } from './permissions.js';

/** The permissions button and its popover, bound to the product on show and its permissions. */
export function PermissionsButton(): JSX.Element {
  const panel = usePermissionsPanel({
    permissions: ALL_PERMISSIONS,
    product: productStore,
    state: productPermissionsStore,
    refresh: refreshProductPermissions,
    choose: chooseProductPermission,
    reset: resetProductPermissions,
  });
  return <PermissionsItem {...panel} />;
}
