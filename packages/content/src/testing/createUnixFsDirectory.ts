// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import * as dagPb from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import type { CID } from 'multiformats/cid';
import { RAW } from '../codecs.js';
import { createSha256Cid } from './createSha256Cid.js';
import { encodeText } from './textCodec.js';

/** A UnixFS directory of raw-leaf files, as a block map by CID string and its root CID. */
export function createUnixFsDirectory(files: Record<string, string>): { root: CID; blocks: Map<string, Uint8Array> } {
  const blocks = new Map<string, Uint8Array>();
  const links = Object.entries(files).map(([name, content]) => {
    const bytes = encodeText(content);
    const cid = createSha256Cid(bytes, RAW);
    blocks.set(cid.toString(), bytes);
    return { Name: name, Hash: cid, Tsize: bytes.length };
  });
  const node = dagPb.encode(dagPb.prepare({ Data: new UnixFS({ type: 'directory' }).marshal(), Links: links }));
  const root = createSha256Cid(node, dagPb.code);
  blocks.set(root.toString(), node);
  return { root, blocks };
}
