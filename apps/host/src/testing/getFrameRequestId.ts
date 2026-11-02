// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { decodeWireMessage } from '@parity/truapi';

/** The request id of a wire frame. Throws when the frame does not decode. */
export function getFrameRequestId(message: Uint8Array): string {
  const decoded = decodeWireMessage(message);
  if (decoded.isErr()) {
    throw decoded.error;
  }
  return decoded.value.requestId;
}
