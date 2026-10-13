// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { PermissionGroup } from '@dotli/host-runtime';
import type { PermissionEntry } from '@dotli/ui-entities';

/** Why the panel has nothing to change: the app is still loading, none loaded here, or its permissions are unreadable. */
export type PermissionsNotice = 'loading' | 'no-app' | 'unavailable';

/** One permission of the menu, under its group. */
export interface MenuPermission extends PermissionEntry {
  group: PermissionGroup;
}
