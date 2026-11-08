// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { AppVersion } from '@dotli/resolver';
import type { ProductManifests } from './cachedManifest.js';
import type { H160Address } from './h160Address.js';

/**
 * What the page shows of a product: its name, description, the root manifest's version, the app's version and its
 * dotNS owner.
 */
export type ProductFacts = {
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

/** What the manifests publish that the page shows, without the keys they lack. */
export function getProductFacts({ root, app, owner }: ProductManifests): ProductFacts {
  return {
    ...(root.kind === 'ok'
      ? {
          displayName: root.value.displayName,
          description: root.value.description,
          manifestVersion: root.value.$v,
        }
      : {}),
    ...(app.kind === 'ok' && app.value.kind === 'app' ? { appVersion: app.value.appVersion } : {}),
    ...(owner ? { owner } : {}),
  };
}
