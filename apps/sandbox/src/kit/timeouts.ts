// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The sandbox's own waits, in milliseconds. */
export const SANDBOX_TIMEOUTS = {
  /** How long the host has to deliver the contract after the sandbox first asks for it. */
  CONTRACT: 6_000,
  /** How often the sandbox re-asks the host for its contract until a valid reply arrives. */
  CONTRACT_RETRY_INTERVAL: 250,
  /** `controllerchange` after the service worker registers. */
  SW_READY: 10_000,
  /** The service worker's acknowledgement of the archive the sandbox hands it. */
  SW_ARCHIVE_ACK: 10_000,
  /** The service worker's answer to the version check. A worker that misses it is left as it is. */
  SW_VERSION_ANSWER: 1_000,
} as const;
