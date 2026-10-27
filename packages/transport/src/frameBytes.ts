// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Branded } from '@dotli/shared';

/** One whole frame as the bytes it is, which goes to the provider as it is. */
export type FrameBytes = Branded<Uint8Array, 'FrameBytes'>;

/** Marks `bytes` as one whole frame. Returns the same bytes. */
export function toFrameBytes(bytes: Uint8Array): FrameBytes {
  // The one place plain bytes become a whole frame
  return bytes as FrameBytes;
}
