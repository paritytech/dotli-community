// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points, each its own chunk, so both apps' boot leaves Solid out.

export const loadOverlaysMount = () => import('./overlays/mount.js');

export const loadErrorPageMount = () => import('./error-page/mount.js');
