// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points, each its own chunk, so the page boot leaves them out.

import type * as DebugPanelHostNamespace from './debugPanelHost.js';

/** The page as the debug panel reads it. Rejects when its chunk fails to load. */
export async function loadDebugPanelHost(): Promise<typeof DebugPanelHostNamespace.debugPanelHost> {
  return (await import('./debugPanelHost.js')).debugPanelHost;
}
