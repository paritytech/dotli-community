// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { CarReader } from '@ipld/car';
import type { CID } from 'multiformats/cid';
import { log } from '@dotli/shared';
import { isCarFile } from './isCarFile.js';
import type { ArchiveFiles } from './types.js';
import { assertBlockMatchesCid, assertSameContentId, createVerifyingBlockSource } from './verify.js';
import { walkUnixFsDag } from './walkUnixFsDag.js';

type Params = {
  /** The CID the response must match. Omit it only for bytes already trusted. */
  expectedRoot?: CID | undefined;
};

/** A non-CAR response is a single `index.html`. `expectedRoot` binds the response to the requested CID. */
export async function parseIpfsResponse(buffer: Uint8Array, { expectedRoot }: Params = {}): Promise<ArchiveFiles> {
  if (isCarFile(buffer)) {
    return parseCarFile(buffer, expectedRoot);
  }
  if (expectedRoot !== undefined) {
    assertBlockMatchesCid(expectedRoot, buffer);
    log.event(`Block ${expectedRoot.toString()} verified`, { flow: 'content', bytes: buffer.length });
  }
  return { 'index.html': buffer };
}

/**
 * Pass `expectedRoot` for untrusted transports, so the root must match it. Every block is hash-verified.
 * Omit it only for bytes already trusted, such as a CAR re-packed under a smoldot-verified CID.
 */
async function parseCarFile(buffer: Uint8Array, expectedRoot?: CID): Promise<ArchiveFiles> {
  const reader = await CarReader.fromBytes(buffer);
  const roots = await reader.getRoots();
  const rootCid = roots[0];

  if (rootCid === undefined) {
    throw new Error('CAR file has no roots');
  }

  if (expectedRoot !== undefined) {
    assertSameContentId(rootCid, expectedRoot);
  }

  let blocks = 0;
  let bytes = 0;
  const files = await walkUnixFsDag({
    rootCid,
    parseInnerArchive: parseIpfsResponse,
    blockSource: createVerifyingBlockSource(async (cid: CID) => {
      const block = await reader.get(cid);
      if (!block) {
        throw new Error(`CAR is missing block for ${cid.toString()}`);
      }
      blocks += 1;
      bytes += block.bytes.length;
      return block.bytes;
    }),
  });
  log.event(`CAR ${rootCid.toString()} verified: ${String(blocks)} blocks`, { flow: 'content', blocks, bytes });
  return files;
}
