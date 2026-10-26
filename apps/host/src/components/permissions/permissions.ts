// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { EnforceablePermissionName, PermissionGroup } from '../../runtime/permissions.js';

/** One permission as its row shows it. */
export type PermissionEntry = {
  name: EnforceablePermissionName;
  label: string;
};

/** Why the panel has nothing to change: the app is still loading, none loaded here, or its permissions are unreadable. */
export type PermissionsNotice = 'loading' | 'no-app' | 'unavailable';

/** One permission of the menu, under its group. */
export type MenuPermission = {
  group: PermissionGroup;
} & PermissionEntry;
