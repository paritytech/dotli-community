// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { blake2b } from '@noble/hashes/blake2.js';
import { catchError } from '@dotli/shared/testing';
import { CID } from 'multiformats/cid';
import { create } from 'multiformats/hashes/digest';
import { BLAKE2B_256, DAG_PB, RAW } from './codecs.js';
import { createSha256Cid } from './testing/createSha256Cid.js';
import { encodeText } from './testing/textCodec.js';
import {
  assertBlockMatchesCid,
  assertSameContentId,
  createRootVerifyingBlockSource,
  createVerifyingBlockSource,
  isBlockMatchingCid,
} from './verify.js';

const SHA2_512 = 0x13;

function blake2bCid(bytes: Uint8Array, codec = RAW): CID {
  return CID.createV1(codec, create(BLAKE2B_256, blake2b(bytes, { dkLen: 32 })));
}

describe('isBlockMatchingCid', () => {
  it('As the block relay, I keep bytes that hash to their CID', () => {
    // Given
    const bytes = encodeText('hello dot.li');

    // When
    const matches = isBlockMatchingCid(createSha256Cid(bytes, RAW).toString(), bytes);

    // Then
    expect(matches).toBe(true);
  });

  it('As the block relay, I never keep a block whose multihash I cannot recompute', () => {
    // Given a CID on the identity multihash (0x00)
    const bytes = encodeText('hello dot.li');
    const cid = CID.createV1(RAW, create(0x00, bytes)).toString();

    // When
    const matches = isBlockMatchingCid(cid, bytes);

    // Then
    expect(matches).toBe(false);
  });

  it('As the block relay, I never keep a block asked for by a CID that does not parse', () => {
    // Given a CID string that is not a CID
    const cid = 'not-a-cid';

    // When
    const matches = isBlockMatchingCid(cid, encodeText('hello dot.li'));

    // Then
    expect(matches).toBe(false);
  });
});

describe('assertBlockMatchesCid', () => {
  it('As a content loader, I accept bytes that hash to their sha2-256 CID', () => {
    // Given
    const bytes = encodeText('hello dot.li');

    // When
    const error = catchError(() => {
      assertBlockMatchesCid(createSha256Cid(bytes, RAW), bytes);
    });

    // Then
    expect(error).toBeUndefined();
  });

  it('As a content loader, I accept bytes that hash to their blake2b-256 CID', () => {
    // Given
    const bytes = encodeText('bulletin content');

    // When
    const error = catchError(() => {
      assertBlockMatchesCid(blake2bCid(bytes), bytes);
    });

    // Then
    expect(error).toBeUndefined();
  });

  it('As a content loader, I name a mismatch as a verification failure, so my caller can tell it from a transport one', () => {
    // Given
    const cid = createSha256Cid(encodeText('the real index.html'), RAW);

    // When
    const error = catchError(() => {
      assertBlockMatchesCid(cid, encodeText('something else'));
    });

    // Then
    expect(error).toMatchObject({ name: 'ContentVerificationError' });
  });

  it('As a content loader, I fail closed on a multihash I cannot recompute', () => {
    // Given
    const bytes = encodeText('payload');
    const cid = CID.createV1(RAW, create(SHA2_512, new Uint8Array(64)));

    // When
    const error = catchError(() => {
      assertBlockMatchesCid(cid, bytes);
    });

    // Then
    expect(error).toMatchObject({ message: expect.stringMatching(/unsupported multihash/i) as string });
  });
});

describe('createVerifyingBlockSource', () => {
  it('As a content loader, I pass on bytes that match the CID I asked for', async () => {
    // Given
    const bytes = encodeText('block bytes');
    const cid = createSha256Cid(bytes, RAW);
    const wrapped = createVerifyingBlockSource(() => Promise.resolve(bytes));

    // When
    const block = wrapped(cid);

    // Then
    await expect(block).resolves.toEqual(bytes);
  });

  it('As a content loader, I fail a block whose source returned bytes for another CID', async () => {
    // Given
    const cid = createSha256Cid(encodeText('expected'), RAW);
    const wrapped = createVerifyingBlockSource(() => Promise.resolve(encodeText('attacker')));

    // When
    const block = wrapped(cid);

    // Then
    await expect(block).rejects.toThrow(/hash mismatch/i);
  });
});

describe('createRootVerifyingBlockSource', () => {
  it('As a content loader, I pass on a root block that matches its CID', async () => {
    // Given
    const rootCid = createSha256Cid(encodeText('root'), DAG_PB);
    const wrapped = createRootVerifyingBlockSource(rootCid, () => Promise.resolve(encodeText('root')));

    // When
    const block = wrapped(rootCid);

    // Then
    await expect(block).resolves.toEqual(encodeText('root'));
  });

  it('As a content loader, I fail a tampered root block', async () => {
    // Given
    const rootCid = createSha256Cid(encodeText('root'), DAG_PB);
    const wrapped = createRootVerifyingBlockSource(rootCid, () => Promise.resolve(encodeText('tampered root')));

    // When
    const block = wrapped(rootCid);

    // Then
    await expect(block).rejects.toThrow(/hash mismatch/i);
  });

  it('As a content loader, I pass interior blocks through without verifying them', async () => {
    // Given
    const rootCid = createSha256Cid(encodeText('root'), DAG_PB);
    const childCid = createSha256Cid(encodeText('child'), RAW);
    const wrapped = createRootVerifyingBlockSource(rootCid, () => Promise.resolve(encodeText('not the child bytes')));

    // When
    const block = wrapped(childCid);

    // Then
    await expect(block).resolves.toEqual(encodeText('not the child bytes'));
  });
});

describe('assertSameContentId', () => {
  it('As a content loader, I accept an archive whose root is the CID I asked for', () => {
    // Given
    const cid = createSha256Cid(encodeText('root'), DAG_PB);

    // When
    const error = catchError(() => {
      assertSameContentId(cid, cid);
    });

    // Then
    expect(error).toBeUndefined();
  });

  it('As a content loader, I take CIDv0 and CIDv1 of the same content as the same root', () => {
    // Given
    const v1 = createSha256Cid(encodeText('same content'), DAG_PB);
    const v0 = v1.toV0();

    // When
    const errors = [
      catchError(() => {
        assertSameContentId(v0, v1);
      }),
      catchError(() => {
        assertSameContentId(v1, v0);
      }),
    ];

    // Then
    expect(errors).toEqual([undefined, undefined]);
  });

  it('As a content loader, I reject an archive whose declared root is not the one I asked for', () => {
    // Given
    const requested = createSha256Cid(encodeText('legit site'), DAG_PB);
    const attacker = createSha256Cid(encodeText('phishing clone'), DAG_PB);

    // When
    const error = catchError(() => {
      assertSameContentId(attacker, requested);
    });

    // Then
    expect(error).toMatchObject({ message: expect.stringMatching(/does not match requested/i) as string });
  });

  it('As a content loader, I reject a root with a matching hash but a different codec', () => {
    // Given
    const bytes = encodeText('ambiguous');

    // When
    const error = catchError(() => {
      assertSameContentId(createSha256Cid(bytes, RAW), createSha256Cid(bytes, DAG_PB));
    });

    // Then
    expect(error).toMatchObject({ message: expect.stringMatching(/does not match requested/i) as string });
  });
});
