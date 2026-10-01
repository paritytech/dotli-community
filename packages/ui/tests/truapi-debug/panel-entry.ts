// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The single place the characterization suite obtains the TrUAPI debug
// panel from. Swapping the panel implementation means changing this one
// import; every test goes through `loadPanel()`.

export interface PanelModule {
  setupTruapiDebugPanel: (options?: { capacity?: number; startCollapsed?: boolean }) => () => void;
}

export function loadPanel(): Promise<PanelModule> {
  return import('../../src/components/truapi-debug/mount.js');
}
