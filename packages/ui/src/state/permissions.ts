// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Permission statuses stay in `permissions.ts` (async, per product). A change
 * is an occurrence, not state, so it is announced as a window event.
 */

export type PermissionChange =
  { kind: 'grant'; label: string; permission: string } | { kind: 'device'; label: string; permission: string };

/**
 * Dispatch the event the permissions island and bridge listen for:
 * `dotli:permission-changed` for grants, `dotli:device-permission-changed`
 * for device permissions (the bridge reloads the iframe on it). Both events
 * always carry `{ label, permission }`.
 */
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
