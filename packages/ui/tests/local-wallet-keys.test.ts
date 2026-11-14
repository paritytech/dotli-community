// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { sign, verify } from '@scure/sr25519';
import initCore, {
  deriveProductAccountPublicKey,
  deriveProductSubtreePublicKey,
} from '@parity/truapi-host/wasm/testing';
import {
  deriveHardPath,
  identityKeypair,
  indexBytes,
  junctionChainCode,
  productAccountKeypair,
} from '../src/local-wallet-keys.js';

/** The published core's own derivation, the reference these keys must match. */
async function loadCore(): Promise<void> {
  const glue = import.meta.resolve('@parity/truapi-host/wasm/testing');
  await initCore({ module_or_path: await readFile(new URL('truapi_server_bg.wasm', glue)) });
}

/** SCALE `DerivationIndex::Index(index)`: variant 0, then the u32 little-endian. */
function scaleIndex(index: number): Uint8Array {
  const bytes = new Uint8Array(5);
  new DataView(bytes.buffer).setUint32(1, index, true);
  return bytes;
}

const ENTROPY = new Uint8Array(32).fill(0xab);

describe('local wallet keys', () => {
  it('derive the product accounts and identity account the core derives', async () => {
    await loadCore();
    for (const productId of ['uid.paseo', 'uid.testnet', 'chat.paseo']) {
      const subtree = deriveProductSubtreePublicKey(ENTROPY, productId);
      expect(deriveHardPath(ENTROPY, ['product', productId]).publicKey).toEqual(subtree);
      expect(productAccountKeypair(ENTROPY, productId, 3).publicKey).toEqual(
        deriveProductAccountPublicKey(subtree, scaleIndex(3)),
      );
    }
    expect(identityKeypair(ENTROPY, 'paseo').publicKey).toEqual(
      deriveProductAccountPublicKey(deriveProductSubtreePublicKey(ENTROPY, 'uid.paseo'), scaleIndex(0)),
    );
  });

  it('sign in the substrate context with the derived key', () => {
    const keys = identityKeypair(ENTROPY, 'paseo');
    const message = new TextEncoder().encode('challenge');
    expect(verify(message, sign(keys.secretKey, message), keys.publicKey)).toBe(true);
  });

  it('encode junctions and indexes as the core does', () => {
    expect(junctionChainCode('product').subarray(0, 8)).toEqual(
      Uint8Array.of(7 << 2, ...new TextEncoder().encode('product')),
    );
    expect(junctionChainCode('42').subarray(0, 8)).toEqual(Uint8Array.of(42, 0, 0, 0, 0, 0, 0, 0));
    expect(junctionChainCode('x'.repeat(40))).toHaveLength(32);
    expect(indexBytes(1).subarray(0, 4)).toEqual(Uint8Array.of(1, 0, 0, 0));
    expect(() => indexBytes(-1)).toThrow();
  });
});
