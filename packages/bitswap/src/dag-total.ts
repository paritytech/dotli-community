// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The sum of a dag-pb node's link `Tsize`s, or null when the bytes are not a node with links. Hand-decoded so the 40kB
 * `@ipld/dag-pb` decoder stays out of the eager host bundle. Links are field 2, and each carries Tsize as varint field 3.
 */
export function readDagTotal(bytes: Uint8Array): number | null {
  try {
    let i = 0;
    let total = 0;
    let sawLink = false;
    const readVarint = (): number => {
      let result = 0;
      let shift = 0;
      for (const b of bytes.subarray(i)) {
        i += 1;
        result += (b & 0x7f) * 2 ** shift;
        if ((b & 0x80) === 0) {
          break;
        }
        shift += 7;
      }
      return result;
    };
    while (i < bytes.length) {
      const key = readVarint();
      const field = key >> 3;
      const wire = key & 0x7;
      if (wire !== 2) {
        return null;
      }
      const len = readVarint();
      if (field === 2) {
        const end = i + len;
        while (i < end) {
          const lk = readVarint();
          const lf = lk >> 3;
          const lw = lk & 0x7;
          if (lw === 0) {
            const v = readVarint();
            if (lf === 3) {
              total += v;
              sawLink = true;
            }
          } else if (lw === 2) {
            // `i += readVarint()` would read `i` before the call advanced it.
            const skip = readVarint();
            i += skip;
          } else {
            return null;
          }
        }
        i = end;
      } else {
        i += len;
      }
    }
    return sawLink ? total : null;
  } catch {
    return null;
  }
}
