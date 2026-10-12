// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export const WORKSPACE_LIMITS = Object.freeze({
  maxFiles: 64,
  // The permanent /home root is not counted against this limit.
  maxDirectories: 256,
  maxFileBytes: 1024 * 1024,
  maxPathBytes: 200,
});
