// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { must } from '@dotli/shared/testing';
import { RAW } from './codecs.js';
import { readArchiveFiles } from './readArchiveFiles.js';
import { createBitswapBlockSource } from './testing/createBitswapBlockSource.js';
import { createGatewayFetch } from './testing/createGatewayFetch.js';
import { createPackedSite } from './testing/createPackedSite.js';
import { createSha256Cid } from './testing/createSha256Cid.js';
import { createUnixFsDirectory } from './testing/createUnixFsDirectory.js';
import { listReportedNames } from './testing/listReportedNames.js';
import { decodeText, encodeText } from './testing/textCodec.js';

/** The metrics, measurements and tags the page reports, recorded for each test. */
let metrics: RecordingSentry;

beforeEach(() => {
  metrics = bindRecordingSentry({ onFinished: onTestFinished });
});

describe('readArchiveFiles', () => {
  it('As a dotli developer, I read every file of a directory over a block source and no metrics are reported', async () => {
    // Given
    const { root, blocks } = createUnixFsDirectory({ 'index.html': '<h1>hi</h1>', 'app.js': 'run()' });

    // When
    const files = await readArchiveFiles(root.toString(), { blockSource: createBitswapBlockSource(blocks) });

    // Then
    expect(Object.keys(files).sort()).toEqual(['app.js', 'index.html']);
    expect(decodeText(must(files['app.js'], 'app.js'))).toBe('run()');
    expect(listReportedNames(metrics)).toEqual([]);
  });

  it('As a dotli developer, I read a single raw block and get it as index.html, the name the sandbox serves it under', async () => {
    // Given
    const bytes = encodeText('<p>one file</p>');
    const root = createSha256Cid(bytes, RAW);

    // When
    const files = await readArchiveFiles(root.toString(), {
      blockSource: createBitswapBlockSource(new Map([[root.toString(), bytes]])),
    });

    // Then
    expect(Object.keys(files)).toEqual(['index.html']);
    expect(decodeText(must(files['index.html'], 'index.html'))).toBe('<p>one file</p>');
  });

  it('As a dotli developer, I read a root block that does not hash to its CID and the read is refused', async () => {
    // Given
    const root = createSha256Cid(encodeText('the real content'), RAW);

    // When
    const read = readArchiveFiles(root.toString(), {
      blockSource: createBitswapBlockSource(new Map([[root.toString(), encodeText('substituted')]])),
    });

    // Then
    await expect(read).rejects.toMatchObject({ name: 'ContentVerificationError' });
  });

  it('As a dotli developer, I read a directory whose leaf block was tampered with and the read is refused', async () => {
    // Given a source that bypasses the host relay and swaps the bytes of one file
    const { root, blocks } = createUnixFsDirectory({ 'index.html': '<h1>hi</h1>', 'app.js': 'run()' });
    const leaf = createSha256Cid(encodeText('run()'), RAW).toString();
    blocks.set(leaf, encodeText('steal()'));

    // When the archive is read over that source
    const read = readArchiveFiles(root.toString(), { blockSource: createBitswapBlockSource(blocks) });

    // Then the tampered block is refused
    await expect(read).rejects.toMatchObject({ name: 'ContentVerificationError' });
  });

  it('As a visitor on the gateway backend, I open a site packed as one CAR under a raw CID and get its files, as over bitswap', async () => {
    // Given a site packed as one CAR under a raw CID
    const { root, car } = createPackedSite({ 'index.html': '<h1>hi</h1>', 'app.js': 'run()' });

    // When it is read over the gateway and over a block source
    const viaGateway = await readArchiveFiles(root.toString(), { gateway: true, fetch: createGatewayFetch(car) });
    const viaBitswap = await readArchiveFiles(root.toString(), {
      blockSource: createBitswapBlockSource(new Map([[root.toString(), car]])),
    });

    // Then both give the same files
    expect(Object.keys(viaGateway).sort()).toEqual(['app.js', 'index.html']);
    expect(viaGateway).toEqual(viaBitswap);
  });

  it('As a visitor on the gateway backend, I open a single raw page and it still reads as index.html', async () => {
    // Given a single raw page
    const bytes = encodeText('<p>one file</p>');
    const root = createSha256Cid(bytes, RAW);

    // When it is read over the gateway
    const files = await readArchiveFiles(root.toString(), { gateway: true, fetch: createGatewayFetch(bytes) });

    // Then it reads as index.html
    expect(Object.keys(files)).toEqual(['index.html']);
    expect(decodeText(must(files['index.html'], 'index.html'))).toBe('<p>one file</p>');
  });
});
