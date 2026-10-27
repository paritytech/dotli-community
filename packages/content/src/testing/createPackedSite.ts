// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import * as CarBufferWriter from '@ipld/car/buffer-writer';
import { CID } from 'multiformats/cid';
import { RAW } from '../codecs.js';
import { createSha256Cid } from './createSha256Cid.js';
import { createUnixFsDirectory } from './createUnixFsDirectory.js';

/** A whole site packed as one CAR, the way some uploaders store it under a raw-codec CID. */
export function createPackedSite(files: Record<string, string>): { root: CID; car: Uint8Array } {
  const site = createUnixFsDirectory(files);
  const writer = CarBufferWriter.createWriter(new ArrayBuffer(64 * 1024), { roots: [site.root] });
  for (const [cid, bytes] of site.blocks) {
    writer.write({ cid: CID.parse(cid), bytes });
  }
  const car = writer.close({ resize: true });
  return { root: createSha256Cid(car, RAW), car };
}
