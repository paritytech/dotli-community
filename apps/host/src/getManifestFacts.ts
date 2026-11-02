// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ManifestFacts } from './runtime/formatAppVersion.js';
import type { ProductManifests } from './cachedManifest.js';

/** What the manifests publish that the page shows, without the keys they lack. */
export function getManifestFacts({ root, app }: ProductManifests): ManifestFacts {
  return {
    ...(root.kind === 'ok' ? { displayName: root.value.displayName, manifestVersion: root.value.$v } : {}),
    ...(app.kind === 'ok' && app.value.kind === 'app' ? { appVersion: app.value.appVersion } : {}),
  };
}
