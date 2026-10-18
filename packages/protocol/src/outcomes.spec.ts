// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { TransportVersionMismatchError, denied, domain, hostFailure } from '@dotli/transport';
import {
  ProtocolFatalError,
  ProtocolInitFailedError,
  ProtocolPortReleasedError,
  ProtocolRequestError,
  ProtocolVersionMismatchError,
} from './errors.js';
import { failureOf, frameStatusEnd, fromTransportError, remoteFailureOf } from './outcomes.js';

describe('failureOf', () => {
  it("As a frame that waits on another, I read its frame status end as the protocol's error classes", () => {
    // When
    const ends = [
      failureOf('frame', 'status', domain({ tag: 'fatal', value: 'wasm trap' })),
      failureOf('frame', 'status', domain({ tag: 'initFailed', value: 'chainHead follow stopped' })),
      failureOf('frame', 'status', domain({ tag: 'released', value: 'The worker let go of this tab' })),
      failureOf('frame', 'status', domain({ tag: 'versionMismatch', value: 'The peer speaks version 9' })),
    ];

    // Then
    expect(ends[0]).toBeInstanceOf(ProtocolFatalError);
    expect(ends[1]).toBeInstanceOf(ProtocolInitFailedError);
    expect(ends[2]).toBeInstanceOf(ProtocolPortReleasedError);
    expect(ends[3]).toBeInstanceOf(ProtocolVersionMismatchError);
    expect(ends.map(error => error.message)).toEqual([
      'wasm trap',
      'chainHead follow stopped',
      'The worker let go of this tab',
      'The peer speaks version 9',
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

describe('frameStatusEnd', () => {
  it('As a frame, I end my status typed for a protocol failure and as its failure for any other, and the host reads each back', () => {
    // Given
    const errors = [
      new ProtocolFatalError('wasm trap'),
      new ProtocolInitFailedError('chainHead follow stopped'),
      new ProtocolPortReleasedError('The worker let go of this tab'),
      new ProtocolVersionMismatchError('The peer speaks version 9'),
      new TypeError('boot broke'),
    ];

    // When
    const ends = errors.map(frameStatusEnd);

    // Then
    expect(ends).toEqual([
      domain({ tag: 'fatal', value: 'wasm trap' }),
      domain({ tag: 'initFailed', value: 'chainHead follow stopped' }),
      domain({ tag: 'released', value: 'The worker let go of this tab' }),
      domain({ tag: 'versionMismatch', value: 'The peer speaks version 9' }),
      hostFailure('TypeError: boot broke'),
    ]);
    const read = ends.map(end => failureOf('frame', 'status', end));
    expect(read.map(error => [error.name, error.message])).toEqual(errors.map(error => [error.name, error.message]));
  });
});

describe('fromTransportError', () => {
  it("As a frame, I end my status on a link's version mismatch typed, and the host reads it as the protocol's mismatch", () => {
    // Given
    const mismatch = new TransportVersionMismatchError(3, 9);

    // When
    const end = frameStatusEnd(fromTransportError(mismatch));
    const read = failureOf('frame', 'status', end);

    // Then
    expect(end).toEqual(domain({ tag: 'versionMismatch', value: mismatch.message }));
    expect(read).toBeInstanceOf(ProtocolVersionMismatchError);
    expect(read.message).toBe(mismatch.message);
  });
});

describe('remoteFailureOf', () => {
  it("As a frame, I type the resolver failures the host's error screen tells apart by name, and no other", () => {
    // Given
    const named = (name: string, message: string): Error => Object.assign(new Error(message), { name });

    // When
    const failures = [
      remoteFailureOf(named('NetworkSyncTimeoutError', 'Asset Hub did not sync')),
      remoteFailureOf(named('ApiStoppedError', 'The light client stopped')),
      remoteFailureOf(new TypeError('bad label')),
      remoteFailureOf('not an error'),
    ];

    // Then
    expect(failures).toEqual([
      { tag: 'syncTimeout', value: 'Asset Hub did not sync' },
      { tag: 'apiStopped', value: 'The light client stopped' },
      null,
      null,
    ]);
  });
});
