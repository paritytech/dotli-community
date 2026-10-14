// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { CID } from 'multiformats/cid';
import { create } from 'multiformats/hashes/digest';
import {
  assertBlockMatchesCid,
  assertSameContentId,
  blockMatchesCid,
  verifyingBlockSource,
  rootVerifyingBlockSource,
} from './verify.js';

const RAW = 0x55;
const DAG_PB = 0x70;
const SHA2_256 = 0x12;
const BLAKE2B_256 = 0xb220;
const SHA2_512 = 0x13;

function sha256Cid(bytes: Uint8Array, codec = RAW): CID {
  return CID.createV1(codec, create(SHA2_256, sha256(bytes)));
}

function blake2bCid(bytes: Uint8Array, codec = RAW): CID {
  return CID.createV1(codec, create(BLAKE2B_256, blake2b(bytes, { dkLen: 32 })));
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('blockMatchesCid', () => {
  it('As the block relay, I keep bytes that hash to their CID', () => {
    // Given
    const bytes = enc('hello dot.li');

    // When
    const matches = blockMatchesCid(sha256Cid(bytes).toString(), bytes);

    // Then
    expect(matches).toBe(true);
  });

  it('As the block relay, I never keep a block whose multihash I cannot recompute', () => {
    // Given a CID on the identity multihash (0x00)
    const bytes = enc('hello dot.li');
    const cid = CID.createV1(RAW, create(0x00, bytes)).toString();

    // When
    const matches = blockMatchesCid(cid, bytes);

    // Then
    expect(matches).toBe(false);
  });

  it('As the block relay, I never keep a block asked for by a CID that does not parse', () => {
    // Given a CID string that is not a CID
    const cid = 'not-a-cid';

    // When
    const matches = blockMatchesCid(cid, enc('hello dot.li'));

    // Then
    expect(matches).toBe(false);
  });
});

describe('assertBlockMatchesCid', () => {
  it('As a content loader, I accept bytes that hash to their sha2-256 CID', () => {
    // Given
    const bytes = enc('hello dot.li');

    // When
    const check = (): void => {
      assertBlockMatchesCid(sha256Cid(bytes), bytes);
    };

    // Then
    expect(check).not.toThrow();
  });

  it('As a content loader, I accept bytes that hash to their blake2b-256 CID', () => {
    // Given
    const bytes = enc('bulletin content');

    // When
    const check = (): void => {
      assertBlockMatchesCid(blake2bCid(bytes), bytes);
    };

    // Then
    expect(check).not.toThrow();
  });

  it('As a content loader, I reject bytes a peer substituted under a valid CID', () => {
    // Given
    const cid = sha256Cid(enc('the real index.html'));
    const tampered = enc('<script>steal()</script>');

    // When
    const check = (): void => {
      assertBlockMatchesCid(cid, tampered);
    };

    // Then
    expect(check).toThrow(/hash mismatch/i);
  });

  it('As a content loader, I name a mismatch as a verification failure, so my caller can tell it from a transport one', () => {
    // Given
    const cid = sha256Cid(enc('the real index.html'));

    // When
    const check = (): void => {
      assertBlockMatchesCid(cid, enc('something else'));
    };

    // Then
    expect(check).toThrow(expect.objectContaining({ name: 'ContentVerificationError' }) as Error);
  });

  it('As a content loader, I fail closed on a multihash I cannot recompute', () => {
    // Given
    const bytes = enc('payload');
    const cid = CID.createV1(RAW, create(SHA2_512, new Uint8Array(64)));

    // When
    const check = (): void => {
      assertBlockMatchesCid(cid, bytes);
    };

    // Then
    expect(check).toThrow(/unsupported multihash/i);
  });
});

describe('verifyingBlockSource', () => {
  it('As a content loader, I pass on bytes that match the CID I asked for', async () => {
    // Given
    const bytes = enc('block bytes');
    const cid = sha256Cid(bytes);
    const wrapped = verifyingBlockSource(() => Promise.resolve(bytes));

    // When
    const block = wrapped(cid);

    // Then
    await expect(block).resolves.toEqual(bytes);
  });

  it('As a content loader, I fail a block whose source returned bytes for another CID', async () => {
    // Given
    const cid = sha256Cid(enc('expected'));
    const wrapped = verifyingBlockSource(() => Promise.resolve(enc('attacker')));

    // When
    const block = wrapped(cid);

    // Then
    await expect(block).rejects.toThrow(/hash mismatch/i);
  });
});

describe('rootVerifyingBlockSource', () => {
  it('As a content loader, I pass on a root block that matches its CID', async () => {
    // Given
    const rootCid = sha256Cid(enc('root'), DAG_PB);
    const wrapped = rootVerifyingBlockSource(rootCid, () => Promise.resolve(enc('root')));

    // When
    const block = wrapped(rootCid);

    // Then
    await expect(block).resolves.toEqual(enc('root'));
  });

  it('As a content loader, I fail a tampered root block', async () => {
    // Given
    const rootCid = sha256Cid(enc('root'), DAG_PB);
    const wrapped = rootVerifyingBlockSource(rootCid, () => Promise.resolve(enc('tampered root')));

    // When
    const block = wrapped(rootCid);

    // Then
    await expect(block).rejects.toThrow(/hash mismatch/i);
  });

  it('As a content loader, I pass interior blocks through without verifying them', async () => {
    // Given
    const rootCid = sha256Cid(enc('root'), DAG_PB);
    const childCid = sha256Cid(enc('child'));
    const wrapped = rootVerifyingBlockSource(rootCid, () => Promise.resolve(enc('not the child bytes')));

    // When
    const block = wrapped(childCid);

    // Then
    await expect(block).resolves.toEqual(enc('not the child bytes'));
  });
});

describe('assertSameContentId', () => {
  it('As a content loader, I accept an archive whose root is the CID I asked for', () => {
    // Given
    const cid = sha256Cid(enc('root'), DAG_PB);

    // When
    const check = (): void => {
      assertSameContentId(cid, cid);
    };

    // Then
    expect(check).not.toThrow();
  });

  it('As a content loader, I take CIDv0 and CIDv1 of the same content as the same root', () => {
    // Given
    const v1 = sha256Cid(enc('same content'), DAG_PB);
    const v0 = v1.toV0();

    // When
    const checks = [
      (): void => {
        assertSameContentId(v0, v1);
      },
      (): void => {
        assertSameContentId(v1, v0);
      },
    ];

    // Then
    for (const check of checks) {
      expect(check).not.toThrow();
    }
  });

  it('As a content loader, I reject an archive whose declared root is not the one I asked for', () => {
    // Given
    const requested = sha256Cid(enc('legit site'), DAG_PB);
    const attacker = sha256Cid(enc('phishing clone'), DAG_PB);

    // When
    const check = (): void => {
      assertSameContentId(attacker, requested);
    };

    // Then
    expect(check).toThrow(/does not match requested/i);
  });

  it('As a content loader, I reject a root with a matching hash but a different codec', () => {
    // Given
    const bytes = enc('ambiguous');

    // When
    const check = (): void => {
      assertSameContentId(sha256Cid(bytes, RAW), sha256Cid(bytes, DAG_PB));
    };

    // Then
    expect(check).toThrow(/does not match requested/i);
  });
});
