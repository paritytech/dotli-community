// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points, each its own chunk, so the page boot leaves them out.

import type * as PermissionsContentNamespace from './panel/PermissionsContent.js';

/** The permissions view. Rejects when its chunk fails to load. */
export function loadPermissionsContent(): Promise<typeof PermissionsContentNamespace> {
  return import('./panel/PermissionsContent.js');
}
