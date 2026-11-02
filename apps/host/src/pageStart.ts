// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Read at import on purpose: the moment this module evaluates is the moment it marks.
/** When the shell's entry had loaded what boot needs, in `performance.now()` time. */
export const PAGE_START = performance.now();
