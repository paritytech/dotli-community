// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imports nothing, so its own entry loads in Node, where the package's main entry cannot.

export const SANDBOX_SCHEMA_VERSION = 3;

/**
 * Shared by the host writer, this validator and the sandbox's post-validation strip, so the wire format never drifts.
 */
export const SANDBOX_CONTRACT_PARAMS = {
  cid: 'cid',
  chainBackend: 'chainBackend',
  network: 'network',
  fullReset: 'fullReset',
  resolutionId: 'resolutionId',
  v: 'v',
} as const;
