// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Recorded data that is no frame. `cause` is why. */
export class FrameRefusedError extends Error {
  constructor(cause: Error) {
    super('The data is no frame', { cause });
    this.name = 'FrameRefusedError';
  }
}
