// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Permission statuses stay in `permissions.ts` (async, per product). This
 * store only counts changes so components know when to re-read them.
 */

import { createSyncStore } from "./create-store";

export type PermissionChange =
  | { kind: "grant"; label: string; permission?: string }
  | { kind: "device"; label: string; permission: string };

export interface PermissionsState {
  version: number;
  last: PermissionChange | null;
}

const permissions = createSyncStore<PermissionsState>({
  version: 0,
  last: null,
});

export const permissionsState = permissions.read;
export const getPermissionsState = permissions.get;

/**
 * Also dispatches the event the topbar and bridge listen for:
 * `dotli:permission-changed` for grants, `dotli:device-permission-changed`
 * for device permissions (the bridge reloads the iframe on it). A grant's
 * `permission` is optional: PromptPermission never has one to report, so its
 * detail is `{ label }`; the topbar dropdown always names the permission it
 * changed, so its detail is `{ label, permission }`. The key is omitted
 * entirely, not set to `undefined`, when absent.
 */
export function recordPermissionChange(change: PermissionChange): void {
  permissions.set({ version: permissions.get().version + 1, last: change });
  if (change.kind === "grant") {
    window.dispatchEvent(
      new CustomEvent("dotli:permission-changed", {
        detail:
          change.permission === undefined
            ? { label: change.label }
            : { label: change.label, permission: change.permission },
      }),
    );
    return;
  }
  window.dispatchEvent(
    new CustomEvent("dotli:device-permission-changed", {
      detail: { label: change.label, permission: change.permission },
    }),
  );
}
