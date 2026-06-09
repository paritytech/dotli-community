// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

export class ProtocolFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolFatalError";
  }
}

export class ProtocolInitFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolInitFailedError";
  }
}
