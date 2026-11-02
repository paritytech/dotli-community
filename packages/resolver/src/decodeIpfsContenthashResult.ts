// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { decode as decodeContentHash, getCodec } from '@ensdomains/content-hash';

/** Discriminated, so a malformed record is not reported as an unset one. */
export type ContenthashResult =
  | { kind: 'ok'; cid: string }
  | { kind: 'empty' }
  | { kind: 'unsupported-codec'; codec: string | null }
  | { kind: 'decode-error'; cause: unknown };

/**
 * Decodes a contenthash record into an IPFS CID. Never throws: a short or unset record is `empty`, a codec other than
 * IPFS is `unsupported-codec`, and a record the codec cannot read is `decode-error` with the cause.
 */
export function decodeIpfsContenthashResult(contenthashHex: string): ContenthashResult {
  const hex = contenthashHex.startsWith('0x') ? contenthashHex.slice(2) : contenthashHex;
  if (!hex || hex === '0' || hex.length < 4) {
    return { kind: 'empty' };
  }
  let codec: string | null;
  try {
    codec = getCodec(hex) ?? null;
  } catch (cause) {
    return { kind: 'decode-error', cause };
  }
  if (codec !== 'ipfs') {
    return { kind: 'unsupported-codec', codec };
  }
  try {
    const cid = decodeContentHash(hex);
    if (typeof cid === 'string' && cid.length > 0) {
      return { kind: 'ok', cid };
    }
    return {
      kind: 'decode-error',
      cause: new Error('decodeContentHash returned empty'),
    };
  } catch (cause) {
    return { kind: 'decode-error', cause };
  }
}
