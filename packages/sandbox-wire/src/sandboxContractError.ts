// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

type Params = {
  /** Defaults to false, a fatal failure. */
  recoverable?: boolean;
};

/** The sandbox URL breaks the host-to-sandbox contract. Its message is the reason for the failure. */
export class SandboxContractError extends Error {
  override readonly name = 'SandboxContractError';
  /** True when the host can fix the URL by rendering the frame again, false when its build is broken. */
  readonly recoverable: boolean;

  constructor(message: string, { recoverable = false }: Params = {}) {
    super(message);
    this.recoverable = recoverable;
  }
}
