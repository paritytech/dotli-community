// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { toHex } from '@dotli/shared';

/** The hex of the first `max` bytes, with an ellipsis when more follow. Never throws. */
export function formatHexPreview(bytes: Uint8Array, max: number): string {
  const preview = bytes.subarray(0, max);
  return `${toHex(preview)}${bytes.length > max ? '…' : ''}`;
}
