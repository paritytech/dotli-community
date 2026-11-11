// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { bindLogSink, type LogLevel } from '@dotli/shared';
import { RAW } from './codecs.js';
import { fetchArchive } from './fetchArchive.js';
import { createGatewayFetch } from './testing/createGatewayFetch.js';
import { createPackedSite } from './testing/createPackedSite.js';
import { createSha256Cid } from './testing/createSha256Cid.js';
import { encodeText } from './testing/textCodec.js';

/** The metrics, measurements and tags the page reports, recorded for each test. */
let metrics: RecordingSentry;

beforeEach(() => {
  metrics = bindRecordingSentry({ onFinished: onTestFinished });
});

describe('fetchArchive', () => {
  it('As an operator, I watch a block fail and it is counted as an error under its error name and logged', async () => {
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

    // When a product load asks for it
    const fetched = fetchArchive(root.toString(), { bitswapBlockSource: () => Promise.reject(missing) });

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
        emit: ({ level }) => {
          logged.push(level);
        },
      }),
    );
    const teardown = new DOMException('bitswap-relay: aborted, the sandbox frame was torn down', 'AbortError');
    const root = createSha256Cid(encodeText('<p>one</p>'), RAW);

    // When a product load asks for it
    const fetched = fetchArchive(root.toString(), { bitswapBlockSource: () => Promise.reject(teardown) });

    // Then the load fails with it, counted as aborted, and no error is logged
    await expect(fetched).rejects.toBe(teardown);
    expect(metrics.counted('content.bitswap_rpc')).toEqual([{ outcome: 'aborted', reason: 'AbortError' }]);
    expect(logged).not.toContain('error');
  });

  it('As a visitor on the gateway backend, I load a product stored as a CAR under a raw CID and get an archive', async () => {
    // Given a site packed as one CAR under a raw CID
    const { root, car } = createPackedSite({ 'index.html': '<h1>hi</h1>', 'app.js': 'run()' });

    // When a product load fetches it over the gateway
    const result = await fetchArchive(root.toString(), {
      useGateway: true,
      gatewayFetch: createGatewayFetch(car),
    });

    // Then it comes back as an archive
    expect(result.type).toBe('archive');
  });
});
