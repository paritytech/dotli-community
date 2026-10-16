// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page is several islands but one `page` root, so an error page taking the body disposes all of them.
import { registerAppRoot } from '../../mount/app-roots.js';

const parts = new Set<() => void>();

function disposeParts(): void {
  const all = [...parts];
  parts.clear();
  for (const dispose of all) {
    dispose();
  }
}

/** The first island to join registers the page root. The returned function leaves without disposing. */
export function joinLandingRoot(dispose: () => void): () => void {
  if (parts.size === 0) {
    registerAppRoot('page', disposeParts);
  }
  parts.add(dispose);
  return () => {
    parts.delete(dispose);
  };
}
