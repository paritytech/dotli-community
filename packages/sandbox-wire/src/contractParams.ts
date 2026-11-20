// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host-to-sandbox contract's schema version. Kept apart so it imports nothing: the host writer and the sandbox
// validator both read it without pulling in anything else.

export const SANDBOX_SCHEMA_VERSION = 3;
