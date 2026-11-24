// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { bindLogSink, type LogLevel } from '@dotli/shared';
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
    const result = await readArchive(root.toString(), { kind: 'blockSource', blockSource: createBlockSource(blocks) });

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
      kind: 'blockSource',
      blockSource: createBlockSource(new Map([[root.toString(), bytes]])),
    });

    // Then
    expect(result).toEqual({ type: 'single', content: bytes });
  });

  it('As a visitor on the gateway backend, I open a site packed as one CAR under a raw CID and get its files, as over bitswap', async () => {
    // Given a site packed as one CAR under a raw CID
    const { root, car } = createPackedSite({ 'index.html': '<h1>hi</h1>', 'app.js': 'run()' });

    // When it is read over the gateway and over a block source
    const viaGateway = await readArchive(root.toString(), { kind: 'gateway', fetch: createGatewayFetch(car) });
    const viaBitswap = await readArchive(root.toString(), {
      kind: 'blockSource',
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
    const result = await readArchive(root.toString(), { kind: 'gateway', fetch: createGatewayFetch(bytes) });

    // Then it reads as one file
    expect(result).toEqual({ type: 'single', content: bytes });
  });

  it('As an operator, I watch a measured read lose a block and it is counted as an error under its error name and logged', async () => {
    // Given a block no peer holds
    const logged: LogLevel[] = [];
    onTestFinished(
      bindLogSink({
        emit: ({ level }) => {
          logged.push(level);
        },
      }),
    );
    const missing = Object.assign(new Error('provider discovery exhausted'), { name: 'BitswapNotFoundError' });
    const root = createSha256Cid(encodeText('<p>one</p>'), RAW);

    // When a measured read asks for it
    const read = readArchive(
      root.toString(),
      { kind: 'blockSource', blockSource: () => Promise.reject(missing) },
      { measure: true },
    );

    // Then the read fails with it, counted under its name and logged as an error
    await expect(read).rejects.toBe(missing);
    expect(metrics.counted('content.bitswap_rpc')).toEqual([{ outcome: 'error', reason: 'BitswapNotFoundError' }]);
    expect(logged).toContain('error');
  });

  it('As an operator, I watch the frame tear down a measured read and it is counted as aborted with no error logged', async () => {
    // Given a block request the frame gave up as it went away
    const logged: LogLevel[] = [];
    onTestFinished(
      bindLogSink({
        emit: ({ level }) => {
          logged.push(level);
        },
      }),
    );
    const teardown = new DOMException('bitswap-relay: aborted, the sandbox frame was torn down', 'AbortError');
    const root = createSha256Cid(encodeText('<p>one</p>'), RAW);

    // When a measured read asks for it
    const read = readArchive(
      root.toString(),
      { kind: 'blockSource', blockSource: () => Promise.reject(teardown) },
      { measure: true },
    );

    // Then the read fails with it, counted as aborted, and no error is logged
    await expect(read).rejects.toBe(teardown);
    expect(metrics.counted('content.bitswap_rpc')).toEqual([{ outcome: 'aborted', reason: 'AbortError' }]);
    expect(logged).not.toContain('error');
  });
});
