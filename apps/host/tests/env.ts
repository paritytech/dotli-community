// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Env overrides shared by every host test suite.
 *
 * Centralised so a single env change propagates everywhere. Tests
 * import these instead of re-reading `process.env`.
 */

export const DOMAIN = process.env.DOMAIN ?? "host-playground";
export const PORT = process.env.PORT ?? "5173";
export const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS ?? "45000", 10);
