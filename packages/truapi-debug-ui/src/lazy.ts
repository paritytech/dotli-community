// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The panel's own chunk, loaded only in debug mode. A module of its own, since a barrel only re-exports.

import type * as TruapiDebugMountNamespace from './truapiDebugPanel.js';

export type TruapiDebugMountModule = typeof TruapiDebugMountNamespace;

/** Loads the panel's chunk. Rejects with the loader's error when the chunk fails to load. */
export function loadTruapiDebugMount(): Promise<TruapiDebugMountModule> {
  return import('./truapiDebugPanel.js');
}
