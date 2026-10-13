// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The TrUAPI debug panel. It reads the host through the port given to its mount.

export { loadTruapiDebugMount, type TruapiDebugMountModule } from './lazy.js';
export type { DebugPanelHost } from './host.js';
