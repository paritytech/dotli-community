// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points, each its own chunk, so the page boot leaves them out.

import type * as ChainsContentNamespace from './ChainsContent.js';

/** The chains view. Rejects when its chunk fails to load. */
export function loadChainsContent(): Promise<typeof ChainsContentNamespace> {
  return import('./ChainsContent.js');
}
