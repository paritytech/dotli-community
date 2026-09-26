// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Permission statuses stay in `permissions.ts` (async, per product). This
 * store only counts changes so components know when to re-read them.
 */

import { createSyncStore, type ReadableStore } from "./create-store";

export type PermissionChange =
  | { kind: "grant"; label: string; permission: string }
  | { kind: "device"; label: string; permission: string };

export interface PermissionsState {
  version: number;
  last: PermissionChange | null;
}

const permissions = createSyncStore<PermissionsState>({
  version: 0,
  last: null,
});

export const permissionsStore: ReadableStore<PermissionsState> = permissions;
export const getPermissionsState = permissions.get;

/**
 * Also dispatches the event the topbar and bridge listen for:
 * `dotli:permission-changed` for grants, `dotli:device-permission-changed`
 * for device permissions (the bridge reloads the iframe on it). Both events
 * always carry `{ label, permission }`.
 */
export function recordPermissionChange(change: PermissionChange): void {
  permissions.set({ version: permissions.get().version + 1, last: change });
  const eventName =
    change.kind === "grant"
      ? "dotli:permission-changed"
      : "dotli:device-permission-changed";
  window.dispatchEvent(
    new CustomEvent(eventName, {
      detail: { label: change.label, permission: change.permission },
    }),
  );
}
