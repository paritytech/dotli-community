// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import type { DotnsContracts } from '@dotli/config';
import { bindLogSink, type LogLevel } from '@dotli/shared';
import type { Api } from './api.js';
import { PartialStorageReadError } from './errors.js';
import { readRootManifest } from './manifest.js';
import { toExecutableManifestResult, toRootManifestResult } from './manifest-types.js';

const DOTNS = {
  TLD: 'dot',
  DOTNS_CONTENT_RESOLVER: '0x1111111111111111111111111111111111111111',
  STORAGE_SLOTS: { TEXT_RECORDS: 3 },
} as unknown as DotnsContracts;

const ROOT = JSON.stringify({ $v: 1, displayName: 'DOOM', description: 'Doom', icon: { cid: 'bafk', format: 'png' } });
const APP = JSON.stringify({ $v: 1, kind: 'app', appVersion: [0, 1, 9] });
// What `app.doom.paseo` publishes: a schema this host does not read.
const APP_V2 = JSON.stringify({
  $v: 2,
  kind: 'app',
  appVersion: [0, 1, 9],
  runtime: { kind: 'polkavm', abiVersion: 1, entrypoint: 'app.polkavm' },
});

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

describe('toRootManifestResult', () => {
  it.each([null, ''])('As the host reading a root manifest record, I read %j as no manifest', raw => {
    // When / Then
    expect(toRootManifestResult(raw)).toEqual({ kind: 'empty' });
  });

  it('As the host reading a root manifest record, I keep its text next to the valid manifest', () => {
    // When / Then
    expect(toRootManifestResult(ROOT)).toMatchObject({ kind: 'ok', value: { displayName: 'DOOM' }, raw: ROOT });
  });

  it('As the host reading a root manifest record, I report an unknown $v as an unsupported version', () => {
    // Given
    const raw = JSON.stringify({ $v: 3 });

    // When / Then
    expect(toRootManifestResult(raw)).toEqual({ kind: 'unsupported-version', version: 3, raw });
  });

  it('As the host reading a root manifest record, I report text that is not JSON as invalid', () => {
    // When / Then
    expect(toRootManifestResult('{ nope')).toMatchObject({ kind: 'invalid', raw: '{ nope' });
  });
});

describe('toExecutableManifestResult', () => {
  it('As the host reading an executable manifest record, I keep its text next to the valid manifest', () => {
    // When / Then
    expect(toExecutableManifestResult(APP, 'app')).toMatchObject({ kind: 'ok', value: { kind: 'app' }, raw: APP });
  });

  it('As the host reading an executable manifest record, I report a v2 manifest as an unsupported version', () => {
    // When / Then
    expect(toExecutableManifestResult(APP_V2, 'app')).toEqual({ kind: 'unsupported-version', version: 2, raw: APP_V2 });
  });

  it('As the host reading an executable manifest record, I report a manifest read from the wrong subname as invalid', () => {
    // When / Then
    expect(toExecutableManifestResult(APP, 'worker')).toEqual({
      kind: 'invalid',
      errors: ["executable manifest kind 'app' does not match its subname 'worker'"],
      raw: APP,
    });
  });

  it('As the host reading an executable manifest record, I read an empty record as no manifest', () => {
    // When / Then
    expect(toExecutableManifestResult(null, 'app')).toEqual({ kind: 'empty' });
  });
});

describe('readRootManifest', () => {
  it('As a dotli maintainer, a manifest read leaves one breadcrumb with its size and verdict, never the record text', async () => {
    // Given
    const lines = recordLog();

    // When
    const result = await readRootManifest(recordApi(ROOT), DOTNS, 'doom');

    // Then
    expect(result).toMatchObject({ kind: 'ok', value: { displayName: 'DOOM' } });
    expect(lines).toEqual([
      {
        level: 'info',
        message: 'Manifest read',
        attrs: { flow: 'resolve', kind: 'root', bytes: ROOT.length, outcome: 'ok', ms: expect.any(Number) as number },
        args: undefined,
      },
    ]);
  });

  it('As a dotli maintainer, a manifest read that fails leaves its error in the trail', async () => {
    // Given
    const lines = recordLog();
    const failure = new Error('storage read failed');

    // When
    const result = readRootManifest(failingApi(failure), DOTNS, 'doom');

    // Then
    await expect(result).rejects.toBe(failure);
    expect(lines.filter(line => line.level === 'warn')).toEqual([
      {
        level: 'warn',
        message: expect.stringMatching(/^\[dot\.li manifest\] root manifest read failed/) as string,
        attrs: {},
        args: [expect.any(String), failure],
      },
    ]);
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
