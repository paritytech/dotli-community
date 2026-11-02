// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { recordLog } from '@dotli/shared/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { DotnsContracts } from '@dotli/config';
import type { Api } from './createRawApi.js';
import { PartialStorageReadError } from './partialStorageReadError.js';
import { readRootManifest } from './readRootManifest.js';

// A manifest read takes only the TLD, the ContentResolver and the text records slot, so the cast skips the rest.
const DOTNS = {
  TLD: 'dot',
  DOTNS_CONTENT_RESOLVER: '0x1111111111111111111111111111111111111111',
  STORAGE_SLOTS: { TEXT_RECORDS: 3 },
} as unknown as DotnsContracts;

const DOTNS_WITHOUT_TEXT_RECORDS: DotnsContracts = { ...DOTNS, STORAGE_SLOTS: { REGISTRY_RECORDS: 0, CONTENTHASH: 0 } };

const ROOT = JSON.stringify({ $v: 1, displayName: 'DOOM', description: 'Doom', icon: { cid: 'bafk', format: 'png' } });
/**
 * A contract whose text record holds `text`, served slot by slot in the order a read asks: the length slot, then each
 * 32-byte chunk. A chunk index in `missing` reads as unset, as a node that lost it would answer.
 */
function createRecordApi(text: string, missing: readonly number[] = []): Api {
  const bytes = new TextEncoder().encode(text);
  // A Solidity `bytes` value of 32 bytes or more keeps `length * 2 + 1` in its own slot.
  const header = new Uint8Array(32);
  let word = BigInt(bytes.length) * 2n + 1n;
  for (let index = 31; index >= 0; index--) {
    header[index] = Number(word & 0xffn);
    word >>= 8n;
  }
  const chunks = Array.from({ length: Math.ceil(bytes.length / 32) }, (_, chunk) =>
    missing.includes(chunk) ? null : Uint8Array.from({ length: 32 }, (_, offset) => bytes[chunk * 32 + offset] ?? 0),
  );
  const slots: (Uint8Array | null)[] = [header, ...chunks];
  const api: Partial<Api> = {
    withBestBlock: read => read('0xbest'),
    resolveTrieId: () => Promise.resolve(new Uint8Array([1])),
    readSlot: () => Promise.resolve(slots.shift() ?? null),
  };
  // A manifest read calls only the pinned block, the trie id and the slot reads.
  return api as Api;
}

/** A contract whose storage reads fail with `failure`. */
function createFailingApi(failure: Error): Api {
  const api: Partial<Api> = {
    withBestBlock: read => read('0xbest'),
    resolveTrieId: () => Promise.resolve(new Uint8Array([1])),
    readSlot: () => Promise.reject(failure),
  };
  // A manifest read calls only the pinned block, the trie id and the slot reads.
  return api as Api;
}

/** A contract that records the name of every `Api` method a read calls, and holds nothing. */
function createRecordingApi(): { api: Api; calls: string[] } {
  const calls: string[] = [];
  const api: Api = {
    whenReady: () => {
      calls.push('whenReady');
      return Promise.resolve();
    },
    withBestBlock: read => {
      calls.push('withBestBlock');
      return read('0xbest');
    },
    resolveTrieId: () => {
      calls.push('resolveTrieId');
      return Promise.resolve(null);
    },
    readSlot: () => {
      calls.push('readSlot');
      return Promise.resolve(null);
    },
    onStop: () => {
      calls.push('onStop');
      return () => undefined;
    },
    destroy: () => {
      calls.push('destroy');
    },
  };
  return { api, calls };
}

describe('readRootManifest', () => {
  it('As a dotli maintainer, I read a manifest and the log gets a breadcrumb but never the record text', async () => {
    // Given
    const lines = recordLog({ onFinished: onTestFinished });

    // When
    const result = await readRootManifest({ api: createRecordApi(ROOT), dotns: DOTNS, label: 'doom' });

    // Then
    expect(result).toMatchObject({ kind: 'ok', value: { displayName: 'DOOM' } });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const logged = JSON.stringify([line.message, line.attrs, line.args]);
      expect(logged).not.toContain('DOOM');
      expect(logged).not.toContain('bafk');
    }
  });

  it('As a dotli maintainer, I read a manifest whose storage fails and the read rejects with the storage error', async () => {
    // Given
    const failure = new Error('storage read failed');

    // When
    const result = readRootManifest({ api: createFailingApi(failure), dotns: DOTNS, label: 'doom' });

    // Then
    await expect(result).rejects.toBe(failure);
  });

  it('As a dotli maintainer, I read a manifest that stops partway and the read fails as a partial read, not a wrong manifest', async () => {
    // Given a record whose second chunk the node no longer has
    recordLog({ onFinished: onTestFinished });

    // When
    const result = readRootManifest({ api: createRecordApi(ROOT, [1]), dotns: DOTNS, label: 'doom' });

    // Then
    await expect(result).rejects.toBeInstanceOf(PartialStorageReadError);
  });

  it('As a dotli user on a network with no text records, I read a manifest and get unsupported without a storage read or a log line', async () => {
    // Given
    const lines = recordLog({ onFinished: onTestFinished });
    const { api, calls } = createRecordingApi();

    // When
    const result = await readRootManifest({ api, dotns: DOTNS_WITHOUT_TEXT_RECORDS, label: 'doom' });

    // Then
    expect(result).toEqual({ kind: 'unsupported', reason: 'TEXT_RECORDS slot not configured' });
    expect(calls).toEqual([]);
    expect(lines).toEqual([]);
  });
});
