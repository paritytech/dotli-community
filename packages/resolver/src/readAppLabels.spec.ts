// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getActiveServicesConfig } from '@dotli/config';
import type { Api } from './createRawApi.js';
import { readAppLabels } from './readAppLabels.js';
import { computeMappingSlot, computeNamehash } from './storageSlots.js';

/** The ContentResolver's words, by slot key. */
type Storage = Record<string, Uint8Array>;

const dotns = getActiveServicesConfig().dotns;
const BLOCK_HASH = '0x0b';

describe('readAppLabels', () => {
  it('As the name list, I read two labels and see only the one whose app has a contenthash', async () => {
    // Given app.alpha with an inline contenthash, and app.beta with none
    const { api } = createFakeApi({ [contenthashSlot('alpha')]: inlineBytesWord(4) });

    // When the labels are read
    const appLabels = await readAppLabels({ api, dotns, labels: ['alpha', 'beta'] });

    // Then only alpha has an app
    expect(appLabels).toEqual(new Set(['alpha']));
  });

  it('As the name list, I read a label whose contenthash is stored as long bytes and count it as an app', async () => {
    // Given app.alpha with a contenthash longer than one word
    const { api } = createFakeApi({ [contenthashSlot('alpha')]: longBytesWord(40) });

    // When the label is read
    const appLabels = await readAppLabels({ api, dotns, labels: ['alpha'] });

    // Then alpha has an app
    expect(appLabels).toEqual(new Set(['alpha']));
  });

  it("As the name list, I read three labels and read every label's slot in one batch", async () => {
    // Given three labels with no app
    const { api, batches } = createFakeApi({});

    // When the labels are read
    await readAppLabels({ api, dotns, labels: ['alpha', 'beta', 'gamma'] });

    // Then one batch read the three contenthash slots of the ContentResolver
    expect(batches).toEqual([
      {
        contractAddress: dotns.DOTNS_CONTENT_RESOLVER,
        slotKeys: [contenthashSlot('alpha'), contenthashSlot('beta'), contenthashSlot('gamma')],
      },
    ]);
  });
});

/** The ContentResolver slot that holds the contenthash of `app.<label>.<tld>`. */
function contenthashSlot(label: string): `0x${string}` {
  return computeMappingSlot(computeNamehash(`app.${label}.${dotns.TLD}`), dotns.STORAGE_SLOTS.CONTENTHASH);
}

/** A `bytes` value of `length` bytes stored inline: its data, then `length * 2` in the lowest byte. */
function inlineBytesWord(length: number): Uint8Array {
  const word = new Uint8Array(32).fill(0xe3, 0, length);
  word[31] = length * 2;
  return word;
}

/** The base word of a `bytes` value longer than 31 bytes: `length * 2 + 1`. */
function longBytesWord(length: number): Uint8Array {
  const word = new Uint8Array(32);
  word[31] = length * 2 + 1;
  return word;
}

/** An `Api` that answers batched reads of the ContentResolver from `storage` at `BLOCK_HASH`. */
function createFakeApi(storage: Storage) {
  const batches: { contractAddress: string; slotKeys: readonly `0x${string}`[] }[] = [];
  const api: Api = {
    whenReady: () => Promise.resolve(),
    withBestBlock: read => read(BLOCK_HASH),
    resolveTrieId: () => Promise.resolve(null),
    readSlot: () => Promise.reject(new Error('The app read read a single slot')),
    resolveTrieIds: () => Promise.resolve(new Map()),
    readSlots: (contractAddress, slotKeys) => {
      batches.push({ contractAddress, slotKeys });
      return Promise.resolve(slotKeys.map(slotKey => storage[slotKey] ?? null));
    },
    onStop: () => () => undefined,
    destroy: () => undefined,
  };
  return { api, batches };
}
