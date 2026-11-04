// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the page shows of a product: its name, description, the root manifest's version, the app's version and its
// dotNS owner.

import type { AppVersion } from '@dotli/resolver';
import type { H160Address } from '../h160Address.js';

export type ManifestFacts = {
  /** The root manifest's `displayName`. */
  displayName?: string;
  /** The root manifest's `description`. */
  description?: string;
  /** The root manifest's `$v`. */
  manifestVersion?: number;
  /** The app manifest's `appVersion`. */
  appVersion?: AppVersion;
  /** The product's dotNS owner, read with the manifests. */
  owner?: H160Address;
};

/** Returns `version` as `major.minor.patch`, with `-tag` when it has one. Never throws. */
export function formatAppVersion(version: AppVersion): string {
  const base = `${String(version[0])}.${String(version[1])}.${String(version[2])}`;
  if (version.length === 4) {
    return `${base}-${version[3]}`;
  }
  return base;
}
