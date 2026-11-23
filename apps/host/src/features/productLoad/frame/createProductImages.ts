// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The bytes of the images a product's chat trees name. A Bulletin image is one raw block, checked against its CID. An
// archive image is a file of the product's worker archive, which is read once for the page and kept, every block
// checked against its hash. Every failure is an `ImageUnavailableError` the chat feature counts.

import { CID } from 'multiformats/cid';
import { code as RAW_CODE } from 'multiformats/codecs/raw';
import { CONTENT_ERRORS, loadVerify as loadContentVerify, type ArchiveFiles } from '@dotli/content';
import { createAsyncTaskPool } from '@dotli/shared';
import { fetchContentBlock, hostBitswapClient, type PreimageFetch } from '../../chains/index.js';
import { ImageUnavailableError, type ProductImageRead } from '../../chat/index.js';

type Params = {
  /** Fetches a block over the content backend in force. The page's by default. */
  fetchBlock?: PreimageFetch;
  /** The loader of the hashing chunk. The content package's by default. */
  loadVerify?: typeof loadContentVerify;
  /**
   * Reads the files an archive CID names, each block checked against its hash. Over the content backend in force by
   * default, loaded on first use so the frame's chunk carries no archive reader. Rejects when a block cannot be fetched
   * or fails its check.
   */
  readFiles?: (cid: string) => Promise<ArchiveFiles>;
};

export type ProductImages = ReturnType<typeof createProductImages>;

/** What the images of one product read from. */
type ProductImagesParams = {
  /** Resolves the CID of the product's worker archive, or null when it publishes none. */
  readArchiveCid: () => Promise<string | null>;
};

/**
 * Builds the page's image reads. An archive is read at most once for the page, by its CID, and a failed read is tried
 * again by the next image that needs it.
 */
export function createProductImages({
  fetchBlock = fetchContentBlock,
  loadVerify = loadContentVerify,
  readFiles = readServedFiles,
}: Params = {}) {
  // One read per archive at a time, held through an abort, so an image that let go never starts a second read.
  const archiveReads = createAsyncTaskPool({ poolSize: 1, holdSlotOnAbort: true });
  const archives = new Map<string, ArchiveFiles>();

  return {
    /**
     * The image read for one product's chat. It rejects with `ImageUnavailableError`, and with the signal's reason once
     * `signal` aborts: at once while it waits on the archive, and once the fetch stops on a backend that honours it.
     */
    createRead({ readArchiveCid }: ProductImagesParams): ProductImageRead {
      return (source, signal) => {
        switch (source.tag) {
          case 'Bulletin':
            return readBulletinBlock(source.value, signal);
          case 'Archive':
            return readArchiveFile(source.value, readArchiveCid, signal);
        }
      };
    },
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

  async function readArchiveFile(
    path: string,
    readArchiveCid: () => Promise<string | null>,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const cid = await readArchiveCid();
    signal.throwIfAborted();
    if (cid === null) {
      throw new ImageUnavailableError('no_archive', `The product publishes no archive for the image ${path}`);
    }
    const files = await archiveReads.call(() => readArchiveOnce(cid), { pool: cid, signal });
    const bytes = findFile(files, path);
    if (bytes === null) {
      throw new ImageUnavailableError('missing', `The product's archive has no image ${path}`);
    }
    return bytes;
  }

  async function readArchiveOnce(cid: string): Promise<ArchiveFiles> {
    const kept = archives.get(cid);
    if (kept !== undefined) {
      return kept;
    }
    let files: ArchiveFiles;
    try {
      files = await readFiles(cid);
    } catch (error) {
      // The content package names a failed hash check, which reaches here by its name.
      const reason = error instanceof Error && error.name === CONTENT_ERRORS.VERIFICATION ? 'mismatch' : 'fetch';
      throw new ImageUnavailableError(reason, `The product's archive ${cid} could not be read`, { cause: error });
    }
    archives.set(cid, files);
    return files;
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

/** A path relative to the archive root, with or without a leading slash. */
function findFile(files: ArchiveFiles, path: string): Uint8Array | null {
  return files[path] ?? files[path.replace(/^\//, '')] ?? files[`/${path}`] ?? null;
}

async function readServedFiles(cid: string): Promise<ArchiveFiles> {
  const { readServedArchive } = await import('../resolve/readServedArchive.js');
  return readServedArchive(cid, hostBitswapClient, null);
}
