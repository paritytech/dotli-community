// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The message's bytes in a buffer that holds only them, so transferring it moves nothing else. The message's own buffer
 * when it fits exactly, and a copy of a view into a larger one.
 */
export function toTransferableBuffer(message: Uint8Array): ArrayBuffer {
  const { buffer } = message;
  return buffer instanceof ArrayBuffer && message.byteOffset === 0 && message.byteLength === buffer.byteLength
    ? buffer
    : message.slice().buffer;
}
