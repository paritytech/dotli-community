// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { serializeError } from '@dotli/shared';

/** An `Error` named `NonErrorThrow` that stands in for a thrown value that is not one, so Sentry can group it. */
export function toNonErrorThrow(thrown: unknown): Error {
  const synthetic = new Error(serializeError(thrown));
  synthetic.name = 'NonErrorThrow';
  return synthetic;
}
