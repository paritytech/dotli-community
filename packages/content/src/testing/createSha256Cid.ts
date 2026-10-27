// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import { create } from 'multiformats/hashes/digest';
import { SHA2_256 } from '../codecs.js';

/** The CIDv1 that names `bytes` under `codec`, hashed with sha2-256. */
export function createSha256Cid(bytes: Uint8Array, codec: number): CID {
  return CID.createV1(codec, create(SHA2_256, sha256(bytes)));
}
