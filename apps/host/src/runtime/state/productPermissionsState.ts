// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the permissions store shows of the product on show, and how the panel asks what it holds.

import type { PermissionStatus } from '../permissionPolicy.js';

/** `statuses` follow the menu order of `ALL_PERMISSIONS`. */
export type ProductPermissionsState =
  | { status: 'none' }
  | { status: 'reading'; label: string }
  | { status: 'read'; label: string; statuses: readonly PermissionStatus[] }
  | { status: 'failed'; label: string };

/** The statuses read, in the menu order of `ALL_PERMISSIONS`, and the product they belong to. */
export type PermissionsRead = { label: string; statuses: readonly PermissionStatus[] };

/** The statuses read and the product they belong to, or undefined while none are read. Never throws. */
export function getRead(state: ProductPermissionsState): PermissionsRead | undefined {
  switch (state.status) {
    case 'read':
      return state;
    case 'none':
    case 'reading':
    case 'failed':
      return undefined;
  }
}

/** Whether the last read of the product `label`'s permissions failed. Never throws. */
export function isUnreadable(state: ProductPermissionsState, label: string): boolean {
  switch (state.status) {
    case 'failed':
      return state.label === label;
    case 'none':
    case 'reading':
    case 'read':
      return false;
  }
}

/** Whether a permission read is granted. Never throws. */
export function hasGrant(state: ProductPermissionsState): boolean {
  return getRead(state)?.statuses.includes('granted') === true;
}
