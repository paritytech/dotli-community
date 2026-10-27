// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sum of a dag-pb node's link `Tsize`s, or null when the bytes are not a node with links. Hand-decoded so the 40kB
 * `@ipld/dag-pb` decoder stays out of the eager host bundle. Links are field 2, and each carries Tsize as varint field 3.
 */
export function readDagTotal(bytes: Uint8Array): number | null {
  let offset = 0;
  let total = 0;
  let sawLink = false;
  try {
    while (offset < bytes.length) {
      const key = readVarint();
      const field = key >> 3;
      const wire = key & 0x7;
      if (wire !== 2) {
        return null;
      }
      const length = readVarint();
      if (field === 2) {
        const end = offset + length;
        while (offset < end) {
          const linkKey = readVarint();
          const linkField = linkKey >> 3;
          const linkWire = linkKey & 0x7;
          if (linkWire === 0) {
            const value = readVarint();
            if (linkField === 3) {
              total += value;
              sawLink = true;
            }
          } else if (linkWire === 2) {
            // `offset += readVarint()` would read `offset` before the call advanced it.
            const skip = readVarint();
            offset += skip;
          } else {
            return null;
          }
        }
        offset = end;
      } else {
        offset += length;
      }
    }
    return sawLink ? total : null;
  } catch {
    return null;
  }

  function readVarint(): number {
    let result = 0;
    let shift = 0;
    for (const byte of bytes.subarray(offset)) {
      offset += 1;
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        break;
      }
      shift += 7;
    }
    return result;
  }
}
