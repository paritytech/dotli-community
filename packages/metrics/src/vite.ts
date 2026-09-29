// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Build-time entry for the app vite configs, loaded by Node directly, hence
// the `.ts` specifiers. Kept apart from the `@dotli/metrics` barrel so no
// browser bundle reaches it.

export { stripAnalytics } from "./strip-analytics-plugin.ts";
