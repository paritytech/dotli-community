// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { parseInfo, parseMagnet, spanOf, torrentId, verifySpan } from '../src/torrent.js';
import { threeFileTorrent } from './torrent-fixture.js';

describe('torrent files through cache nodes', () => {
  it('As a user agent, I read the infohash and the selected file of a magnet link', () => {
    // Given magnet links with hex and base32 infohashes, a file selection, a hybrid and a v2-only link
    const hex = '2befcb908a1be306ba26451f75d51e83a5f43d36';
    const base32 = 'FPX4XEEKDPRQNORGIUPXLVI6QOS7IPJW';

    // Then the host reads the v1 infohash and the file, and refuses what a cache node would refuse
    expect(parseMagnet(`magnet:?xt=urn:btih:${hex}&dn=x&so=2&x.pe=203.0.113.5:6881`)).toEqual({
      infoHash: hex,
      file: 2,
    });
    expect(parseMagnet(`magnet:?xt=urn:btih:${base32}`)).toEqual({ infoHash: hex });
    expect(parseMagnet(`magnet:?xt=urn:btih:${hex.toUpperCase()}&xt=urn:btmh:1220${'00'.repeat(32)}`).infoHash).toBe(
      hex,
    );
    expect(() => parseMagnet(`magnet:?xt=urn:btmh:1220${'00'.repeat(32)}`)).toThrow(/v2-only/);
    expect(() => parseMagnet(`magnet:?xt=urn:btih:${hex}&so=1,2`)).toThrow(/exactly one file/);
    expect(() => parseMagnet(`https://x/?xt=urn:btih:${hex}`)).toThrow(/not a magnet link/);
    expect(torrentId(hex, 2)).toBe(`bt:${hex}:2`);
  });

  it('As a user agent, I check each span of a torrent piece by piece, and refuse a changed byte, span or info dict', async () => {
    // Given a torrent whose files are not piece-aligned
    const { info, infoHash, all, sizes } = await threeFileTorrent();
    const parsed = parseInfo(info);
    expect(parsed.files.map(file => [file.path, file.length, file.offset])).toEqual([
      ['f0.bin', 100_001, 0],
      ['f1.bin', 300_007, 100_001],
      ['f2.bin', 50_003, 400_008],
    ]);

    for (const [file, size] of sizes.entries()) {
      // When a node sends the span of each file
      const span = spanOf(parsed, file);
      const bytes = all.slice(span.start, span.end);
      const offset = parsed.files[file]?.offset ?? 0;

      // Then the host takes the file from it
      const checked = await verifySpan(info, infoHash, file, bytes);
      expect(checked.value).toEqual(all.slice(offset, offset + size));
      expect(checked.name).toBe(`dir/f${String(file)}.bin`);

      // And refuses one changed byte, a short span and an info dict of another torrent
      const changed = bytes.slice();
      changed[changed.length >> 1] = (changed[changed.length >> 1] ?? 0) ^ 1;
      await expect(verifySpan(info, infoHash, file, changed)).rejects.toThrow(/does not have the hash/);
      await expect(verifySpan(info, infoHash, file, bytes.subarray(1))).rejects.toThrow(/bytes are not/);
      await expect(verifySpan(info, '00'.repeat(20), file, bytes)).rejects.toThrow(/not the one of/);
    }
  });
});
