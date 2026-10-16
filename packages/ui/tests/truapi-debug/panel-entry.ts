// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one place the suite gets the panel from, so a re-implementation swaps this import only.

export interface PanelModule {
  setupTruapiDebugPanel: (options?: { capacity?: number; startCollapsed?: boolean }) => () => void;
}

export function loadPanel(): Promise<PanelModule> {
  return import('../../src/components/truapi-debug/mount.js');
}
