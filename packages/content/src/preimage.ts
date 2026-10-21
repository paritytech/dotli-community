// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { fromHex } from '@dotli/shared';
import { CID } from 'multiformats/cid';
import { create } from 'multiformats/hashes/digest';
import { BLAKE2B_256, RAW } from './codecs.js';

export function hashToCid(hashHex: string): CID {
  const digest = create(BLAKE2B_256, fromHex(hashHex));
  return CID.createV1(RAW, digest);
}
