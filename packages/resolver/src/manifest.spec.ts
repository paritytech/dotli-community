// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import type { DotnsContracts } from '@dotli/config';
import { bindLogSink, type LogLevel } from '@dotli/shared';
import type { Api } from './api.js';
import { PartialStorageReadError } from './errors.js';
import { readRootManifest } from './manifest.js';

const DOTNS = {
  TLD: 'dot',
  DOTNS_CONTENT_RESOLVER: '0x1111111111111111111111111111111111111111',
  STORAGE_SLOTS: { TEXT_RECORDS: 3 },
} as unknown as DotnsContracts;

const ROOT = JSON.stringify({ $v: 1, displayName: 'DOOM', description: 'Doom', icon: { cid: 'bafk', format: 'png' } });
/**
 * A contract whose text record holds `text`, served slot by slot in the order a read asks: the length slot, then each
 * 32-byte chunk. A chunk index in `missing` reads as unset, as a node that lost it would answer.
 */
function recordApi(text: string, missing: readonly number[] = []): Api {
  const bytes = new TextEncoder().encode(text);
  // A Solidity `bytes` value of 32 bytes or more keeps `length * 2 + 1` in its own slot.
  const header = new Uint8Array(32);
  let word = BigInt(bytes.length) * 2n + 1n;
  for (let i = 31; i >= 0; i--) {
    header[i] = Number(word & 0xffn);
    word >>= 8n;
  }
  const chunks = Array.from({ length: Math.ceil(bytes.length / 32) }, (_, i) =>
    missing.includes(i) ? null : Uint8Array.from({ length: 32 }, (_, j) => bytes[i * 32 + j] ?? 0),
  );
  const slots: (Uint8Array | null)[] = [header, ...chunks];
  const api: Partial<Api> = {
    withBestBlock: read => read('0xbest'),
    resolveTrieId: () => Promise.resolve(new Uint8Array([1])),
    readSlot: () => Promise.resolve(slots.shift() ?? null),
  };
  return api as Api;
}

/** A contract whose storage reads fail with `failure`. */
function failingApi(failure: Error): Api {
  const api: Partial<Api> = {
    withBestBlock: read => read('0xbest'),
    resolveTrieId: () => Promise.resolve(new Uint8Array([1])),
    readSlot: () => Promise.reject(failure),
  };
  return api as Api;
}

interface LogLine {
  level: LogLevel;
  message: string;
  attrs: Record<string, unknown> | undefined;
  args: unknown[] | undefined;
}

/** Records what the test logs, until it ends and the sink bound before is back. */
function recordLog(): LogLine[] {
  const lines: LogLine[] = [];
  onTestFinished(
    bindLogSink({
      emit: (level, message, attrs, args) => {
        lines.push({ level, message, attrs, args });
      },
    }),
  );
  return lines;
}

describe('readRootManifest', () => {
  it('As a dotli maintainer, a manifest read leaves a breadcrumb and never the record text', async () => {
    // Given
    const lines = recordLog();

    // When
    const result = await readRootManifest(recordApi(ROOT), DOTNS, 'doom');

    // Then
    expect(result).toMatchObject({ kind: 'ok', value: { displayName: 'DOOM' } });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const logged = JSON.stringify([line.message, line.attrs, line.args]);
      expect(logged).not.toContain('DOOM');
      expect(logged).not.toContain('bafk');
    }
  });

  it('As a dotli maintainer, a manifest read whose storage fails rejects with the storage error', async () => {
    // Given
    const failure = new Error('storage read failed');

    // When
    const result = readRootManifest(failingApi(failure), DOTNS, 'doom');

    // Then
    await expect(result).rejects.toBe(failure);
  });

  it('As a dotli maintainer, a manifest read that stops partway fails with a partial read, not a wrong manifest', async () => {
    // Given a record whose second chunk the node no longer has
    recordLog();

    // When
    const result = readRootManifest(recordApi(ROOT, [1]), DOTNS, 'doom');

    // Then
    await expect(result).rejects.toBeInstanceOf(PartialStorageReadError);
  });
});
