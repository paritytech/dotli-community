// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { RAW } from './codecs.js';
import { readArchive } from './readArchive.js';
import { createBlockSource } from './testing/createBlockSource.js';
import { createGatewayFetch } from './testing/createGatewayFetch.js';
import { createPackedSite } from './testing/createPackedSite.js';
import { createSha256Cid } from './testing/createSha256Cid.js';
import { createUnixFsDirectory } from './testing/createUnixFsDirectory.js';
import { listReportedNames } from './testing/listReportedNames.js';
import { encodeText } from './testing/textCodec.js';

/** The metrics, measurements and tags the page reports, recorded for each test. */
let metrics: RecordingSentry;

beforeEach(() => {
  metrics = bindRecordingSentry({ onFinished: onTestFinished });
});

describe('readArchive', () => {
  it('As a dotli developer, I read every file of a directory over a block source and no metrics are reported', async () => {
    // Given
    const { root, blocks } = createUnixFsDirectory({ 'index.html': '<h1>hi</h1>', 'app.js': 'run()' });

    // When
    const result = await readArchive(root.toString(), { blockSource: createBlockSource(blocks) });

    // Then
    expect(result).toEqual({
      type: 'archive',
      files: { 'index.html': encodeText('<h1>hi</h1>'), 'app.js': encodeText('run()') },
    });
    expect(listReportedNames(metrics)).toEqual([]);
  });

  it('As a dotli developer, I read a single raw block over a block source and get it as one file', async () => {
    // Given
    const bytes = encodeText('<p>one file</p>');
    const root = createSha256Cid(bytes, RAW);

    // When
    const result = await readArchive(root.toString(), {
      blockSource: createBlockSource(new Map([[root.toString(), bytes]])),
    });

    // Then
    expect(result).toEqual({ type: 'single', content: bytes });
  });

  it('As a visitor on the gateway backend, I open a site packed as one CAR under a raw CID and get its files, as over bitswap', async () => {
    // Given a site packed as one CAR under a raw CID
    const { root, car } = createPackedSite({ 'index.html': '<h1>hi</h1>', 'app.js': 'run()' });

    // When it is read over the gateway and over a block source
    const viaGateway = await readArchive(root.toString(), { gateway: true, fetch: createGatewayFetch(car) });
    const viaBitswap = await readArchive(root.toString(), {
      blockSource: createBlockSource(new Map([[root.toString(), car]])),
    });

    // Then both give the same files
    expect(viaGateway).toMatchObject({ type: 'archive' });
    expect(viaGateway).toEqual(viaBitswap);
  });

  it('As a visitor on the gateway backend, I open a single raw page and it reads as one file', async () => {
    // Given a single raw page
    const bytes = encodeText('<p>one file</p>');
    const root = createSha256Cid(bytes, RAW);

    // When it is read over the gateway
    const result = await readArchive(root.toString(), { gateway: true, fetch: createGatewayFetch(bytes) });

    // Then it reads as one file
    expect(result).toEqual({ type: 'single', content: bytes });
  });
});
