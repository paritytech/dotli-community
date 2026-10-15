// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What a product's manifests publish that the page shows: its name, the root manifest's version and the app's version.

import type { AppVersion } from '@dotli/resolver';

export interface ManifestFacts {
  /** The root manifest's `displayName`. */
  displayName?: string;
  /** The root manifest's `$v`. */
  manifestVersion?: number;
  /** The app manifest's `appVersion`. */
  appVersion?: AppVersion;
}

export function formatAppVersion(version: AppVersion): string {
  const base = `${String(version[0])}.${String(version[1])}.${String(version[2])}`;
  if (version.length === 4) {
    return `${base}-${version[3]}`;
  }
  return base;
}
