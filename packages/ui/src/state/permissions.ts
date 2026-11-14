// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A permission change is an occurrence, not state, so it goes out as a window event.

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

/**
 * Announce that `permissions` of `label` changed together, as one grant
 * change. The bridge then refreshes the core's permission policy, and only a
 * committed policy change (a device permission changing the iframe's `allow`
 * attribute) replaces the app, once for all of them. Nothing changed
 * announces nothing.
 */
export function recordPermissionsChanged(label: string, permissions: readonly string[]): void {
  const permission = permissions[0];
  if (permission === undefined) {
    return;
  }
  recordPermissionChange({ kind: 'grant', label, permission });
}
