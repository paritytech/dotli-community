// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import * as dagPb from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import * as CarBufferWriter from '@ipld/car/buffer-writer';
import { CID } from 'multiformats/cid';
import { create } from 'multiformats/hashes/digest';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { bindLogSink, type LogLevel } from '@dotli/shared';
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

/** A whole site packed as one CAR, the way some uploaders store it under a raw-codec CID. */
function packedSite(files: Record<string, string>): { root: CID; car: Uint8Array } {
  const site = directory(files);
  const writer = CarBufferWriter.createWriter(new ArrayBuffer(64 * 1024), { roots: [site.root] });
  for (const [cid, bytes] of site.blocks) {
    writer.write({ cid: CID.parse(cid), bytes });
  }
  const car = writer.close({ resize: true });
  return { root: cidOf(car, RAW), car };
}

/** An IPFS gateway that answers every request with `body`. */
function gatewayAnswering(body: Uint8Array): typeof fetch {
  return () => Promise.resolve(new Response(body.slice()));
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

  it('As a dotli developer, I read a directory whose leaf block was tampered with and the read is refused', async () => {
    // Given a source that bypasses the host relay and swaps the bytes of one file
    const { root, blocks } = directory({ 'index.html': '<h1>hi</h1>', 'app.js': 'run()' });
    const leaf = cidOf(enc('run()'), RAW).toString();
    blocks.set(leaf, enc('steal()'));

    // When the archive is read over that source
    const read = readArchiveFiles(root.toString(), { blockSource: sourceOf(blocks) });

    // Then the tampered block is refused
    await expect(read).rejects.toMatchObject({ name: 'ContentVerificationError' });
  });

  it('As a visitor on the gateway backend, I open a site packed as one CAR under a raw CID and get its files, as over bitswap', async () => {
    // Given a site packed as one CAR under a raw CID
    const { root, car } = packedSite({ 'index.html': '<h1>hi</h1>', 'app.js': 'run()' });

    // When it is read over the gateway and over a block source
    const viaGateway = await readArchiveFiles(root.toString(), { gateway: true, fetch: gatewayAnswering(car) });
    const viaBitswap = await readArchiveFiles(root.toString(), {
      blockSource: sourceOf(new Map([[root.toString(), car]])),
    });

    // Then both give the same files
    expect(Object.keys(viaGateway).sort()).toEqual(['app.js', 'index.html']);
    expect(viaGateway).toEqual(viaBitswap);
  });

  it('As a visitor on the gateway backend, I open a single raw page and it still reads as index.html', async () => {
    // Given a single raw page
    const bytes = enc('<p>one file</p>');
    const root = cidOf(bytes, RAW);

    // When it is read over the gateway
    const files = await readArchiveFiles(root.toString(), { gateway: true, fetch: gatewayAnswering(bytes) });

    // Then it reads as index.html
    expect(Object.keys(files)).toEqual(['index.html']);
    expect(text(files['index.html'])).toBe('<p>one file</p>');
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
    expect(metrics.distributions).toContainEqual(
      expect.objectContaining({ name: 'dotli.content.bitswap_blocks', value: 3 }),
    );
    expect(metrics.counts.map(({ name }) => name)).not.toContain('dotli.content.bitswap_blocks');
  });

  it('As an operator, I watch a block fail and it is counted as an error under its error name and logged', async () => {
    // Given a block no peer holds
    const logged: LogLevel[] = [];
    onTestFinished(
      bindLogSink({
        emit: level => {
          logged.push(level);
        },
      }),
    );
    const missing = Object.assign(new Error('provider discovery exhausted'), { name: 'BitswapNotFoundError' });
    const root = cidOf(enc('<p>one</p>'), RAW);

    // When a product load asks for it
    const fetched = fetchArchive(root.toString(), undefined, { bitswapBlockSource: () => Promise.reject(missing) });

    // Then the load fails with it, counted under its name and logged as an error
    await expect(fetched).rejects.toBe(missing);
    expect(metrics.counted('content.bitswap_rpc')).toEqual([{ outcome: 'error', reason: 'BitswapNotFoundError' }]);
    expect(logged).toContain('error');
  });

  it('As an operator, I watch the frame tear down a fetch and it is counted as aborted with no error logged', async () => {
    // Given a block request the sandbox frame gave up as it went away
    const logged: LogLevel[] = [];
    onTestFinished(
      bindLogSink({
        emit: level => {
          logged.push(level);
        },
      }),
    );
    const teardown = new DOMException('bitswap-relay: aborted, the sandbox frame was torn down', 'AbortError');
    const root = cidOf(enc('<p>one</p>'), RAW);

    // When a product load asks for it
    const fetched = fetchArchive(root.toString(), undefined, { bitswapBlockSource: () => Promise.reject(teardown) });

    // Then the load fails with it, counted as aborted, and no error is logged
    await expect(fetched).rejects.toBe(teardown);
    expect(metrics.counted('content.bitswap_rpc')).toEqual([{ outcome: 'aborted', reason: 'AbortError' }]);
    expect(logged).not.toContain('error');
  });

  it('As a visitor on the gateway backend, I load a product stored as a CAR under a raw CID and get an archive', async () => {
    // Given a site packed as one CAR under a raw CID
    const { root, car } = packedSite({ 'index.html': '<h1>hi</h1>', 'app.js': 'run()' });

    // When a product load fetches it over the gateway
    const result = await fetchArchive(root.toString(), undefined, {
      useGateway: true,
      gatewayFetch: gatewayAnswering(car),
    });

    // Then it comes back as an archive
    expect(result.type).toBe('archive');
  });
});
