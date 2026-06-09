// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Snapshot of the currently loaded product's manifest values, exposed so
// surfaces outside the resolver can read what the host shell pulled
// without re-issuing the network reads.

export interface ActiveRootManifestSnapshot {
  /** Schema version from the root manifest's `$v` field. */
  schemaVersion: number;
  displayName: string;
  description: string;
  icon: { cid: string; format: "jpeg" | "png" };
}

export interface ActiveAppManifestSnapshot {
  /** Schema version from the executable manifest's `$v` field. */
  schemaVersion: number;
  /** Tuple as published, e.g. `[1, 0, 0]` or `[1, 0, 0, "alpha"]`. */
  appVersion:
    | readonly [number, number, number]
    | readonly [number, number, number, string];
}

let activeRoot: ActiveRootManifestSnapshot | null = null;
let activeApp: ActiveAppManifestSnapshot | null = null;

/** Store the loaded root manifest. Pass `null` to clear (used by tests). */
export function setActiveRootManifest(
  snapshot: ActiveRootManifestSnapshot | null,
): void {
  activeRoot = snapshot;
}

/** Returns the loaded root manifest snapshot, or `null` when none is set. */
export function getActiveRootManifest(): ActiveRootManifestSnapshot | null {
  return activeRoot;
}

/** Store the loaded app executable manifest. Pass `null` to clear. */
export function setActiveAppManifest(
  snapshot: ActiveAppManifestSnapshot | null,
): void {
  activeApp = snapshot;
}

/** Returns the loaded app executable manifest snapshot, or `null`. */
export function getActiveAppManifest(): ActiveAppManifestSnapshot | null {
  return activeApp;
}

/**
 * Format an `appVersion` tuple the way users expect to see it on screen,
 * e.g. `1.0.0` or `1.0.0-alpha`.
 */
export function formatAppVersion(
  version: ActiveAppManifestSnapshot["appVersion"],
): string {
  const base = `${String(version[0])}.${String(version[1])}.${String(version[2])}`;
  if (version.length === 4) {
    return `${base}-${version[3]}`;
  }
  return base;
}
