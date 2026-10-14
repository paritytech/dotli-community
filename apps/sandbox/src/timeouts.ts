// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The sandbox's own waits, in milliseconds. */
export const SANDBOX_TIMEOUTS = {
  /** A host recover reply. Exceeds the host's recover rate-limit window, so a limited request fails visibly. */
  RECOVER: 6_000,
  /** `controllerchange` after the service worker registers. */
  SW_READY: 10_000,
  /** The service worker's acknowledgement of the archive the sandbox hands it. */
  SW_ARCHIVE_ACK: 10_000,
} as const;
