// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import * as dagPb from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import { CID } from 'multiformats/cid';
import { create } from 'multiformats/hashes/digest';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { fetchArchive, readArchiveFiles } from './fetch.js';

/** The metrics, measurements and tags the page reports, recorded for each test. */
let metrics: RecordingSentry;

beforeEach(() => {
  metrics = bindRecordingSentry({ onFinished: onTestFinished });
});

/** Every metric, measurement and tag the page reported, by name. */
function reported(): string[] {
  return [
    ...[...metrics.counts, ...metrics.distributions, ...metrics.gauges, ...metrics.measurements].map(
      ({ name }) => name,
    ),
    ...metrics.tags.map(({ key }) => key),
  ];
}

const RAW = 0x55;
const SHA2_256 = 0x12;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

function cidOf(bytes: Uint8Array, codec: number): CID {
  return CID.createV1(codec, create(SHA2_256, sha256(bytes)));
}

/** A UnixFS directory of raw-leaf files, as a block map and its root CID. */
function directory(files: Record<string, string>): { root: CID; blocks: Map<string, Uint8Array> } {
  const blocks = new Map<string, Uint8Array>();
  const links = Object.entries(files).map(([name, content]) => {
    const bytes = enc(content);
    const cid = cidOf(bytes, RAW);
    blocks.set(cid.toString(), bytes);
    return { Name: name, Hash: cid, Tsize: bytes.length };
  });
  const node = dagPb.encode(dagPb.prepare({ Data: new UnixFS({ type: 'directory' }).marshal(), Links: links }));
  const root = cidOf(node, dagPb.code);
  blocks.set(root.toString(), node);
  return { root, blocks };
}

function sourceOf(blocks: Map<string, Uint8Array>): (cid: string) => Promise<Uint8Array> {
  return cid => {
    const bytes = blocks.get(cid);
    return bytes === undefined ? Promise.reject(new Error(`not found: ${cid}`)) : Promise.resolve(bytes);
  };
}

describe('readArchiveFiles', () => {
  it('As a dotli developer, it reads every file of a directory over a block source, with no metrics', async () => {
    // Given
    const { root, blocks } = directory({ 'index.html': '<h1>hi</h1>', 'app.js': 'run()' });

    // When
    const files = await readArchiveFiles(root.toString(), { blockSource: sourceOf(blocks) });

    // Then
    expect(Object.keys(files).sort()).toEqual(['app.js', 'index.html']);
    expect(text(files['app.js'])).toBe('run()');
    expect(reported()).toEqual([]);
  });

  it('As a dotli developer, a single raw block reads as index.html, the name the sandbox serves it under', async () => {
    // Given
    const bytes = enc('<p>one file</p>');
    const root = cidOf(bytes, RAW);

    // When
    const files = await readArchiveFiles(root.toString(), {
      blockSource: sourceOf(new Map([[root.toString(), bytes]])),
    });

    // Then
    expect(Object.keys(files)).toEqual(['index.html']);
    expect(text(files['index.html'])).toBe('<p>one file</p>');
  });

  it('As a dotli developer, a root block that does not hash to the CID is refused', async () => {
    // Given
    const root = cidOf(enc('the real content'), RAW);

    // When
    const read = readArchiveFiles(root.toString(), {
      blockSource: sourceOf(new Map([[root.toString(), enc('substituted')]])),
    });

    // Then
    await expect(read).rejects.toMatchObject({ name: 'ContentVerificationError' });
  });
});

describe('fetchArchive', () => {
  it('As an operator, a product load over bitswap reports its fetch timing and block count', async () => {
    // Given
    const { root, blocks } = directory({ 'index.html': '<h1>hi</h1>', 'app.js': 'run()' });

    // When
    await fetchArchive(root.toString(), undefined, { bitswapBlockSource: sourceOf(blocks) });

    // Then
    expect(reported()).toEqual(
      expect.arrayContaining(['dotli.content.fetch', 'dotli.content.bitswap_rpc', 'dotli.content.bitswap_blocks']),
    );
  });
});
