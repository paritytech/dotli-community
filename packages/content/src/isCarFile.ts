// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A two-entry CBOR map whose first key is "roots". */
const HEADER_START = [0xa2, 0x65, 0x72, 0x6f, 0x6f, 0x74, 0x73];

/** Whether the bytes open with a CAR v1 header. */
export function isCarFile(buffer: Uint8Array): boolean {
  // The header's length, a varint of at most 9 bytes.
  let offset = 0;
  let shift = 0;
  let headerLength = 0;
  for (const byte of buffer.subarray(0, 9)) {
    headerLength |= (byte & 0x7f) << shift;
    offset++;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }

  if (buffer.length < offset + headerLength) {
    return false;
  }
  return HEADER_START.every((byte, index) => buffer[offset + index] === byte);
}
