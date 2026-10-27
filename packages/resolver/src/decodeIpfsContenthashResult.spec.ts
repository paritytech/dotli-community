// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { decodeIpfsContenthashResult } from './decodeIpfsContenthashResult.js';

describe('decodeIpfsContenthashResult', () => {
  it.each(['', '0x', '0x0'])(
    'As the resolver reading dotNS storage, I read the empty contenthash %j as no record',
    contenthash => {
      // When
      const result = decodeIpfsContenthashResult(contenthash);

      // Then
      expect(result).toEqual({ kind: 'empty' });
    },
  );

  it('As the resolver reading dotNS storage, I read a too-short contenthash as no record', () => {
    // When
    const result = decodeIpfsContenthashResult('0xab');

    // Then
    expect(result).toEqual({ kind: 'empty' });
  });

  it('As the resolver reading dotNS storage, I read a contenthash of another codec as unsupported', () => {
    // When the contenthash carries the Swarm codec prefix
    const result = decodeIpfsContenthashResult('0xe40101');

    // Then
    expect(result).toMatchObject({ kind: 'unsupported-codec' });
  });

  it('As the resolver reading dotNS storage, I read an IPFS CIDv1 contenthash as its CID', () => {
    // Given
    // Real ENS-encoded IPFS CIDv1: encode('ipfs', 'bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4')
    const validIpfsContenthash = 'e3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f';

    // When
    const result = decodeIpfsContenthashResult(validIpfsContenthash);

    // Then
    expect(result).toEqual({
      kind: 'ok',
      cid: 'bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4',
    });
  });

  it('As the resolver reading dotNS storage, I read a contenthash the same with or without its 0x prefix', () => {
    // Given
    const hex = '0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f';
    const hexWithout = 'e3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f';

    // When
    const withPrefix = decodeIpfsContenthashResult(hex);
    const withoutPrefix = decodeIpfsContenthashResult(hexWithout);

    // Then
    expect(withPrefix).toEqual(withoutPrefix);
  });
});
