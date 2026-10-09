// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A permission change is an occurrence, not state, so it goes out as a window event.

import { isDevicePermission } from '../permissions.js';

export type PermissionChange =
  { kind: 'grant'; label: string; permission: string } | { kind: 'device'; label: string; permission: string };

/** The bridge reloads the iframe on `dotli:device-permission-changed`. */
export function recordPermissionChange(change: PermissionChange): void {
  const eventName = change.kind === 'grant' ? 'dotli:permission-changed' : 'dotli:device-permission-changed';
  window.dispatchEvent(
    new CustomEvent(eventName, {
      detail: { label: change.label, permission: change.permission },
    }),
  );
}

/** One announcement, a device change if any of `permissions` sets the iframe's `allow`, so the app reloads once. */
export function recordPermissionsChanged(label: string, permissions: readonly string[]): void {
  const device = permissions.find(name => isDevicePermission(name));
  const permission = device ?? permissions[0];
  if (permission === undefined) {
    return;
  }
  recordPermissionChange({ kind: device === undefined ? 'grant' : 'device', label, permission });
}
