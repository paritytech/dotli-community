// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The loaded product's manifest values, so surfaces outside the resolver skip a second network read.

export interface ActiveRootManifestSnapshot {
  /** Schema version from the root manifest's `$v` field. */
  schemaVersion: number;
  displayName: string;
  description: string;
  /** `format` as published. v1 defines `jpeg` and `png`, and any other value only loses the icon. */
  icon: { cid: string; format: string };
}

export interface ActiveAppManifestSnapshot {
  /** Schema version from the executable manifest's `$v` field. */
  schemaVersion: number;
  appVersion: readonly [number, number, number] | readonly [number, number, number, string];
}

let activeRoot: ActiveRootManifestSnapshot | null = null;
let activeApp: ActiveAppManifestSnapshot | null = null;

export function setActiveRootManifest(snapshot: ActiveRootManifestSnapshot | null): void {
  activeRoot = snapshot;
}

export function getActiveRootManifest(): ActiveRootManifestSnapshot | null {
  return activeRoot;
}

export function setActiveAppManifest(snapshot: ActiveAppManifestSnapshot | null): void {
  activeApp = snapshot;
}

export function getActiveAppManifest(): ActiveAppManifestSnapshot | null {
  return activeApp;
}

export function formatAppVersion(version: ActiveAppManifestSnapshot['appVersion']): string {
  const base = `${String(version[0])}.${String(version[1])}.${String(version[2])}`;
  if (version.length === 4) {
    return `${base}-${version[3]}`;
  }
  return base;
}
