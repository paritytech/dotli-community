// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { CID } from 'multiformats/cid';
import { code as RAW_CODE } from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';
import { loadVerify } from '@dotli/content';
import type { ModuleFiles } from '@dotli/quickjs-runtime';
import type { PreimageFetch } from '../chains/index.js';
import { ImageUnavailableError } from '../chat/index.js';
import { createChatImageRead } from './createChatImageRead.js';

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const DAG_PB_CODE = 0x70;
const NO_FILES: ModuleFiles = new Map();

async function cidOf(bytes: Uint8Array, code = RAW_CODE): Promise<string> {
  return CID.create(1, code, await sha256.digest(bytes)).toString();
}

/** A backend that serves `data` for every block. */
function serving(data: Uint8Array): PreimageFetch {
  return () => Promise.resolve({ data, source: 'smoldot-direct' });
}

async function reasonOf(loading: Promise<unknown>): Promise<string> {
  const error: unknown = await loading.catch((caught: unknown) => caught);
  if (!(error instanceof ImageUnavailableError)) {
    throw new Error('The image loaded, or failed with another error', { cause: error });
  }
  return error.reason;
}

describe('createChatImageRead, Bulletin', () => {
  it('As a user, I see a Bulletin image whose block matches its CID', async () => {
    // Given
    const read = createChatImageRead(NO_FILES, { fetchBlock: serving(PNG), loadVerify });
    const source = { tag: 'Bulletin', value: await cidOf(PNG) } as const;

    // When
    const bytes = await read(source, new AbortController().signal);

    // Then
    expect(bytes).toEqual(PNG);
  });

  it('As a user, I see a Bulletin image the backend serves wrong bytes for as a mismatch', async () => {
    // Given
    const read = createChatImageRead(NO_FILES, { fetchBlock: serving(Uint8Array.of(1, 2, 3)), loadVerify });
    const source = { tag: 'Bulletin', value: await cidOf(PNG) } as const;

    // When
    const reason = await reasonOf(read(source, new AbortController().signal));

    // Then
    expect(reason).toBe('mismatch');
  });

  it('As a user, I see a Bulletin CID that is not one raw block as unsupported, without a fetch', async () => {
    // Given
    const fetched: string[] = [];
    const read = createChatImageRead(NO_FILES, {
      fetchBlock: cid => {
        fetched.push(cid);
        return Promise.resolve({ data: PNG, source: 'smoldot-direct' });
      },
      loadVerify,
    });
    const source = { tag: 'Bulletin', value: await cidOf(PNG, DAG_PB_CODE) } as const;

    // When
    const reason = await reasonOf(read(source, new AbortController().signal));

    // Then
    expect({ reason, fetched }).toEqual({ reason: 'unsupported_cid', fetched: [] });
  });
});

describe('createChatImageRead, archive', () => {
  it('As a user, I see images of the worker archive named with or without a leading slash', async () => {
    // Given
    const files: ModuleFiles = new Map([
      ['logo.png', PNG],
      ['icons/badge.png', PNG],
    ]);
    const read = createChatImageRead(files, { fetchBlock: serving(PNG), loadVerify });

    // When
    const images = await Promise.all([
      read({ tag: 'Archive', value: 'logo.png' }, new AbortController().signal),
      read({ tag: 'Archive', value: '/icons/badge.png' }, new AbortController().signal),
    ]);

    // Then
    expect(images).toEqual([PNG, PNG]);
  });

  it('As a user, I see an image of a path the worker archive does not hold as missing', async () => {
    // Given
    const read = createChatImageRead(new Map([['logo.png', PNG]]), { fetchBlock: serving(PNG), loadVerify });

    // When
    const reason = await reasonOf(read({ tag: 'Archive', value: 'missing.png' }, new AbortController().signal));

    // Then
    expect(reason).toBe('missing');
  });
});
