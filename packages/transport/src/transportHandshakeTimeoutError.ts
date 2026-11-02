// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The opener heard no answer to its handshake within the timeout, counted on the running clock. */
export class TransportHandshakeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportHandshakeTimeoutError';
  }
}
