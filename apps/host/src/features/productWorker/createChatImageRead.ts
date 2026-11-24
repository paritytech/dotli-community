// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The bytes of the images a worker's chat trees name. A Bulletin image is one raw block, checked against its CID. An
// archive image is a file of the worker archive the run already read and checked for its VM. Every failure is an
// `ImageUnavailableError` the chat feature counts.

import { CID } from 'multiformats/cid';
import { code as RAW_CODE } from 'multiformats/codecs/raw';
import type { loadVerify } from '@dotli/content';
import type { ModuleFiles } from '@dotli/quickjs-runtime';
import type { PreimageFetch } from '../chains/index.js';
import { ImageUnavailableError, type ProductImageRead } from '../chat/index.js';

type Params = {
  /** Fetches a Bulletin block over the content backend in force. */
  fetchBlock: PreimageFetch;
  /** Loads the hashing chunk a Bulletin block is checked with. */
  loadVerify: typeof loadVerify;
};

/**
 * Builds the image read of one run's chat over the archive `files` the run holds. The read rejects with
 * `ImageUnavailableError`, and with the signal's reason once `signal` aborts during a Bulletin fetch.
 */
export function createChatImageRead(files: ModuleFiles, { fetchBlock, loadVerify }: Params): ProductImageRead {
  return async (source, signal) => {
    switch (source.tag) {
      case 'Bulletin':
        return readBulletinBlock(source.value, signal);
      case 'Archive':
        return readArchiveFile(source.value);
    }
  };

  async function readBulletinBlock(value: string, signal: AbortSignal): Promise<Uint8Array> {
    const cid = parseRawCid(value);
    let data: Uint8Array;
    try {
      ({ data } = await fetchBlock(value, signal));
    } catch (error) {
      signal.throwIfAborted();
      throw new ImageUnavailableError('fetch', `The Bulletin image ${value} could not be fetched`, { cause: error });
    }
    signal.throwIfAborted();
    if (data.length === 0) {
      throw new ImageUnavailableError('missing', `The backend has no Bulletin image ${value}`);
    }
    const { assertBlockMatchesCid } = await loadVerify();
    try {
      assertBlockMatchesCid(cid, data);
    } catch (error) {
      throw new ImageUnavailableError('mismatch', `The Bulletin image ${value} does not match its CID`, {
        cause: error,
      });
    }
    return data;
  }

  /** A path relative to the archive root, with or without a leading slash. */
  function readArchiveFile(path: string): Uint8Array {
    const bytes = files.get(path) ?? files.get(path.replace(/^\//, '')) ?? files.get(`/${path}`);
    if (bytes === undefined) {
      throw new ImageUnavailableError('missing', `The worker's archive has no image ${path}`);
    }
    return bytes;
  }
}

/** A Bulletin image is one blob, so only a raw block's CID names one. */
function parseRawCid(value: string): CID {
  let cid: CID;
  try {
    cid = CID.parse(value);
  } catch (error) {
    throw new ImageUnavailableError('unsupported_cid', `The Bulletin image ${value} has no valid CID`, {
      cause: error,
    });
  }
  if (cid.code !== RAW_CODE) {
    throw new ImageUnavailableError('unsupported_cid', `The Bulletin image ${value} is not one raw block`);
  }
  return cid;
}
