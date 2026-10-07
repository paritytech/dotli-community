// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// These messages reach the host error page, so the wording is part of the contract with the host.

export const PROTOCOL_APP_ERRORS = {
  SHARED_WORKER_READY_TIMEOUT: 'SharedWorker did not signal ready within timeout',
  INVALID_SHARED_MODE_VALUE: 'Invalid shared mode value',
  INVALID_SHARED_AUTH_VALUE: 'Invalid shared auth value',
  RESOLVE_DOT_NAME_UNSUPPORTED: 'resolveDotName is not served by this protocol mode',
  RESOLVE_OWNER_UNSUPPORTED: 'resolveOwner is not served by this protocol mode',
  RESOLVE_EXECUTABLE_MANIFEST_UNSUPPORTED: 'resolveExecutableManifest is not served by this protocol mode',
  RESOLVE_ROOT_MANIFEST_UNSUPPORTED: 'resolveRootManifest is not served by this protocol mode',
  CHAIN_BROKER_FAILED: 'Failed to create chain broker',
} as const;
