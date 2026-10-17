// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// These messages reach the host error page, so the wording is part of the contract with the host.

export const PROTOCOL_APP_ERRORS = {
  SHARED_WORKER_READY_TIMEOUT: 'SharedWorker did not signal ready within timeout',
  RESOLVE_DOT_NAME_UNSUPPORTED: 'resolveDotName is not served by this protocol mode',
  RESOLVE_OWNER_UNSUPPORTED: 'resolveOwner is not served by this protocol mode',
  RESOLVE_EXECUTABLE_MANIFEST_UNSUPPORTED: 'resolveExecutableManifest is not served by this protocol mode',
  RESOLVE_ROOT_MANIFEST_UNSUPPORTED: 'resolveRootManifest is not served by this protocol mode',
  CHAIN_BROKER_FAILED: 'Failed to create chain broker',
  PORT_CLOSED: 'This tab disconnected from the protocol worker',
  PORT_RELEASED: 'The protocol worker let go of this tab after it went silent',
  WORKER_STATUS_ENDED: 'The protocol worker stopped reporting its status',
} as const;

/** A store call from outside the shared-auth trust boundary, so its refusal is reported apart from bad input. */
export class OriginDeniedError extends Error {
  readonly origin: string | null;

  constructor(store: string, origin: string | null) {
    super(`${store} request denied from origin: ${origin ?? 'none'}`);
    this.name = 'OriginDeniedError';
    this.origin = origin;
  }
}
