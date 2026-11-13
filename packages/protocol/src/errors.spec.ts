// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { TransportUnsupportedProtocolVersionError, denied, domain, hostFailure } from '@dotli/transport';
import { CHAIN_HALTED_ERROR_DATA } from '@dotli/shared';
import {
  ProtocolFatalError,
  ProtocolInitFailedError,
  ProtocolPortReleasedError,
  ProtocolRequestError,
  ProtocolVersionMismatchError,
  getFailure,
  toFrameStatusEnd,
  fromTransportError,
  toRemoteEnd,
} from './errors.js';
import { protocolSchema } from './schema.js';

const { frame, resolve, wallet } = protocolSchema.sections;

describe('getFailure', () => {
  it('As a frame that relays another, I read its failures under the names they crossed with and its call name', () => {
    // When
    const failures = [
      getFailure(resolve.owner, domain({ tag: 'syncTimeout', value: 'Asset Hub did not sync' })),
      getFailure(frame.heartbeat, hostFailure('TypeError: heartbeat refused')),
      getFailure(wallet.read, denied()),
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

describe('toFrameStatusEnd', () => {
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
    const ends = errors.map(toFrameStatusEnd);
    const read = ends.map(end => getFailure(frame.status, end));

    // Then
    expect(ends).toEqual([
      domain({ tag: 'fatal', value: 'wasm trap' }),
      domain({ tag: 'initFailed', value: 'chainHead follow stopped' }),
      domain({ tag: 'released', value: 'The worker let go of this tab' }),
      domain({ tag: 'versionMismatch', value: 'The peer speaks version 9' }),
      hostFailure('TypeError: boot broke'),
    ]);
    expect(read.map(error => [error.name, error.message])).toEqual(errors.map(error => [error.name, error.message]));
  });
});

describe('fromTransportError', () => {
  it("As a frame, I end my status on a link's version mismatch typed, and the host reads it as the protocol's mismatch", () => {
    // Given
    const mismatch = new TransportUnsupportedProtocolVersionError({ wire: 1, schema: 3 }, { wire: 1, schema: 9 });

    // When
    const end = toFrameStatusEnd(fromTransportError(mismatch));
    const read = getFailure(frame.status, end);

    // Then
    expect(end).toEqual(domain({ tag: 'versionMismatch', value: mismatch.message }));
    expect(read).toBeInstanceOf(ProtocolVersionMismatchError);
    expect(read.message).toBe(mismatch.message);
  });
});

describe('toRemoteEnd', () => {
  it("As a frame, I type the resolver failures the host's error screen tells apart, a halted read as a stopped chain, and end any other as my own", () => {
    // Given
    function createNamedError(name: string, message: string): Error {
      return Object.assign(new Error(message), { name });
    }

    // When
    const failures = [
      toRemoteEnd(createNamedError('NetworkSyncTimeoutError', 'Asset Hub did not sync')),
      toRemoteEnd(createNamedError('ApiStoppedError', 'The light client stopped')),
      toRemoteEnd(
        Object.assign(new Error('Chain transport halted'), { name: 'RpcError', data: CHAIN_HALTED_ERROR_DATA }),
      ),
      toRemoteEnd(Object.assign(new Error('Too many requests'), { name: 'RpcError', data: 'other' })),
      toRemoteEnd(new TypeError('bad label')),
    ];

    // Then
    expect(failures).toEqual([
      domain({ tag: 'syncTimeout', value: 'Asset Hub did not sync' }),
      domain({ tag: 'apiStopped', value: 'The light client stopped' }),
      domain({ tag: 'apiStopped', value: 'Chain transport halted' }),
      hostFailure('RpcError: Too many requests'),
      hostFailure('TypeError: bad label'),
    ]);
  });
});
