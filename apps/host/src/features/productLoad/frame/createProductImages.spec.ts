// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { CID } from 'multiformats/cid';
import { code as RAW_CODE } from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';
import { CONTENT_ERRORS, type ArchiveFiles } from '@dotli/content';
import { ImageUnavailableError } from '../../chat/index.js';
import type { PreimageFetch } from '../../chains/index.js';
import { createProductImages } from './createProductImages.js';

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const ARCHIVE_CID = 'bafybeiarchive';
const DAG_PB_CODE = 0x70;

async function cidOf(bytes: Uint8Array, code = RAW_CODE): Promise<string> {
  return CID.create(1, code, await sha256.digest(bytes)).toString();
}

/** A backend that serves `data` for every block. */
function serving(data: Uint8Array): PreimageFetch {
  return () => Promise.resolve({ data, source: 'smoldot-direct' });
}

/** An archive read that waits for the test, and counts how often it ran. */
function heldArchive(files: ArchiveFiles) {
  const reads: { release: () => void }[] = [];
  return {
    reads,
    readFiles: () =>
      new Promise<ArchiveFiles>(resolve => {
        reads.push({ release: () => resolve(files) });
      }),
  };
}

function archiveOf(cid: string | null) {
  return { readArchiveCid: () => Promise.resolve(cid) };
}

async function reasonOf(loading: Promise<unknown>): Promise<string> {
  const error: unknown = await loading.catch((caught: unknown) => caught);
  if (!(error instanceof ImageUnavailableError)) {
    throw new Error('The image loaded, or failed with another error', { cause: error });
  }
  return error.reason;
}

describe('createProductImages, Bulletin', () => {
  it('As a user, I see a Bulletin image whose block matches its CID', async () => {
    // Given
    const read = createProductImages({ fetchBlock: serving(PNG) }).createRead(archiveOf(null));
    const source = { tag: 'Bulletin', value: await cidOf(PNG) } as const;

    // When
    const bytes = await read(source, new AbortController().signal);

    // Then
    expect(bytes).toEqual(PNG);
  });

  it('As a user, I see a Bulletin image the backend serves wrong bytes for as a mismatch', async () => {
    // Given
    const read = createProductImages({ fetchBlock: serving(Uint8Array.of(1, 2, 3)) }).createRead(archiveOf(null));
    const source = { tag: 'Bulletin', value: await cidOf(PNG) } as const;

    // When
    const reason = await reasonOf(read(source, new AbortController().signal));

    // Then
    expect(reason).toBe('mismatch');
  });

  it('As a user, I see a Bulletin CID that is not one raw block as unsupported, without a fetch', async () => {
    // Given
    const fetched: string[] = [];
    const read = createProductImages({
      fetchBlock: cid => {
        fetched.push(cid);
        return Promise.resolve({ data: PNG, source: 'smoldot-direct' });
      },
    }).createRead(archiveOf(null));
    const source = { tag: 'Bulletin', value: await cidOf(PNG, DAG_PB_CODE) } as const;

    // When
    const reason = await reasonOf(read(source, new AbortController().signal));

    // Then
    expect({ reason, fetched }).toEqual({ reason: 'unsupported_cid', fetched: [] });
  });
});

describe('createProductImages, archive', () => {
  it('As a user, I see two images of the product archive, read once for the page', async () => {
    // Given
    const archive = heldArchive({ 'logo.png': PNG, 'icons/badge.png': PNG });
    const read = createProductImages({ readFiles: archive.readFiles }).createRead(archiveOf(ARCHIVE_CID));
    const logo = read({ tag: 'Archive', value: 'logo.png' }, new AbortController().signal);
    const badge = read({ tag: 'Archive', value: '/icons/badge.png' }, new AbortController().signal);

    // When
    await expect.poll(() => archive.reads.length).toBe(1);
    archive.reads[0]?.release();

    // Then
    await expect(Promise.all([logo, badge])).resolves.toEqual([PNG, PNG]);
    expect(archive.reads).toHaveLength(1);
  });

  it('As a user who scrolls past an image while the archive is read, I start no second read for the next image', async () => {
    // Given
    const archive = heldArchive({ 'logo.png': PNG });
    const read = createProductImages({ readFiles: archive.readFiles }).createRead(archiveOf(ARCHIVE_CID));
    const aborter = new AbortController();
    const first = read({ tag: 'Archive', value: 'logo.png' }, aborter.signal);
    await expect.poll(() => archive.reads.length).toBe(1);

    // When
    aborter.abort(new Error('scrolled away'));
    const next = read({ tag: 'Archive', value: 'logo.png' }, new AbortController().signal);
    archive.reads[0]?.release();

    // Then
    await expect(first).rejects.toThrow('scrolled away');
    await expect(next).resolves.toEqual(PNG);
    expect(archive.reads).toHaveLength(1);
  });

  it('As a user, I see an image after an archive read that failed, as the next image reads it again', async () => {
    // Given
    let reads = 0;
    const read = createProductImages({
      readFiles: () => {
        reads += 1;
        return reads === 1 ? Promise.reject(new Error('backend down')) : Promise.resolve({ 'logo.png': PNG });
      },
    }).createRead(archiveOf(ARCHIVE_CID));
    const failed = await reasonOf(read({ tag: 'Archive', value: 'logo.png' }, new AbortController().signal));

    // When
    const bytes = await read({ tag: 'Archive', value: 'logo.png' }, new AbortController().signal);

    // Then
    expect({ failed, bytes }).toEqual({ failed: 'fetch', bytes: PNG });
  });

  it('As a user, I see an image of an archive whose blocks fail their hash check as a mismatch', async () => {
    // Given
    const tampered = Object.assign(new Error('Content hash mismatch'), { name: CONTENT_ERRORS.VERIFICATION });
    const read = createProductImages({ readFiles: () => Promise.reject(tampered) }).createRead(archiveOf(ARCHIVE_CID));

    // When
    const reason = await reasonOf(read({ tag: 'Archive', value: 'logo.png' }, new AbortController().signal));

    // Then
    expect(reason).toBe('mismatch');
  });

  it.each([
    ['a product with no worker archive', null, 'logo.png', 'no_archive'],
    ['a path the archive does not hold', ARCHIVE_CID, 'missing.png', 'missing'],
  ] as const)('As a user, I see an image of %s as unavailable', async (_case, cid, path, expected) => {
    // Given
    const read = createProductImages({ readFiles: () => Promise.resolve({ 'logo.png': PNG }) }).createRead(
      archiveOf(cid),
    );

    // When
    const reason = await reasonOf(read({ tag: 'Archive', value: path }, new AbortController().signal));

    // Then
    expect(reason).toBe(expected);
  });
});
