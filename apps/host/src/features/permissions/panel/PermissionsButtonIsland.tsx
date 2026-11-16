// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { ALL_PERMISSIONS } from '../policy/permissionPolicy.js';
import { browserPermissions } from '../policy/createBrowserPermissions.js';
import { productPermissions } from '../policy/pagePermissions.js';
import { productState } from '../../page/index.js';
import { PermissionsItem } from './PermissionsItem.js';
import { usePermissionsPanel } from './usePermissionsPanel.js';

/** The permissions button and its popover, bound to the product on show and its permissions. */
export function PermissionsButtonIsland(): JSX.Element {
  const panel = usePermissionsPanel({
    permissions: ALL_PERMISSIONS,
    product: productState.store,
    store: productPermissions,
    browser: browserPermissions,
  });
  return <PermissionsItem {...panel} />;
}
