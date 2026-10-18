// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { denied, domain, hostFailure } from '@dotli/transport';
import {
  ProtocolFatalError,
  ProtocolInitFailedError,
  ProtocolPortReleasedError,
  ProtocolRequestError,
} from './errors.js';
import { failureOf } from './outcomes.js';

describe('failureOf', () => {
  it("As a frame that waits on another, I read its frame status end as the protocol's error classes", () => {
    // When
    const ends = [
      failureOf('frame', 'status', domain({ tag: 'fatal', value: 'wasm trap' })),
      failureOf('frame', 'status', domain({ tag: 'initFailed', value: 'chainHead follow stopped' })),
      failureOf('frame', 'status', domain({ tag: 'released', value: 'The worker let go of this tab' })),
    ];

    // Then
    expect(ends[0]).toBeInstanceOf(ProtocolFatalError);
    expect(ends[1]).toBeInstanceOf(ProtocolInitFailedError);
    expect(ends[2]).toBeInstanceOf(ProtocolPortReleasedError);
    expect(ends.map(error => error.message)).toEqual([
      'wasm trap',
      'chainHead follow stopped',
      'The worker let go of this tab',
    ]);
  });

  it('As a frame that relays another, I read its failures under the names they crossed with and its call name', () => {
    // When
    const failures = [
      failureOf('resolve', 'owner', domain({ tag: 'syncTimeout', value: 'Asset Hub did not sync' })),
      failureOf('frame', 'heartbeat', hostFailure('TypeError: heartbeat refused')),
      failureOf('wallet', 'read', denied()),
    ];

    // Then
    const read = failures.map(error =>
      error instanceof ProtocolRequestError ? [error.name, error.message, error.method] : error,
    );
    expect(read).toEqual([
      ['NetworkSyncTimeoutError', 'Asset Hub did not sync', 'resolveOwner'],
      ['TypeError', 'heartbeat refused', 'heartbeat'],
      ['Denied', 'The frame refused the call "localWalletRead"', 'localWalletRead'],
    ]);
  });
});
