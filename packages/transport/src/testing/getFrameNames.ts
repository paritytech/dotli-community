// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Reads a whole conversation as frame names, for order assertions.

import { getFrameName } from './getFrameName.js';
import { readFrame } from './readFrame.js';
import { testSchema } from './testSchema.js';

/** The names of the frames a channel delivered, both ways, in order. */
export function getFrameNames(delivered: readonly Uint8Array[]): string[] {
  return delivered.map(data => getFrameName(readFrame(testSchema, data)));
}
