// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// These messages reach the host error page, so the wording is part of the contract with the host.

export const PROTOCOL_APP_ERRORS = {
  SHARED_WORKER_READY_TIMEOUT: 'SharedWorker did not signal ready within timeout',
  CHAIN_BROKER_FAILED: 'Failed to create chain broker',
  PORT_CLOSED: 'This tab disconnected from the protocol worker',
  PORT_RELEASED: 'The protocol worker let go of this tab after it went silent',
  WORKER_STATUS_ENDED: 'The protocol worker stopped reporting its status',
} as const;
