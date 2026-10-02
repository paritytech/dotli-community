// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { describeError } from '../../src/errors.js';
import { ManifestRejectedError } from '../../src/manifest-gate.js';

/** An error as the protocol client rebuilds it from a failed response. */
function crossedBoundary(message: string, name: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe('host error classification', () => {
  it('does not present a browser worker startup timeout as slow peers', () => {
    const error = describeError(new Error('worker init timed out after 30000ms while initializing the runtime'), true);

    expect({
      kind: error.kind,
      recovery: error.recovery,
      resetProtocol: error.resetProtocol,
    }).toEqual({
      kind: 'worker-init-timeout',
      recovery: 'switch-backend',
      resetProtocol: true,
    });
  });

  it.each([
    ['the halted answer to a read in flight', crossedBoundary('Chain transport halted', 'RpcError')],
    [
      'a follow that stopped',
      crossedBoundary('chainHead follow stopped (cause: ChainHead stopped)', 'ProtocolResponseError'),
    ],
    ['a stopped client, whatever its text', crossedBoundary('stopped', 'ApiStoppedError')],
  ])(
    'As a dotli user on a light client, a resolution whose chain halted twice says the network dropped, for %s',
    (_case, err) => {
      // When
      const error = describeError(err, true);

      // Then
      expect({
        kind: error.kind,
        recovery: error.recovery,
        resetProtocol: error.resetProtocol,
      }).toEqual({
        kind: 'chain-halted',
        recovery: 'switch-backend',
        resetProtocol: undefined,
      });
    },
  );

  it.each([
    [
      'a manifest version this host does not read',
      new ManifestRejectedError('unsupported-version', 'app', '$v 2'),
      'manifest-unsupported-version',
    ],
    [
      'an invalid manifest',
      new ManifestRejectedError('invalid', 'root', 'root manifest displayName must be a non-empty string'),
      'manifest-invalid',
    ],
    [
      'an app manifest without a root manifest',
      new ManifestRejectedError('missing-root', 'root', 'no root manifest'),
      'manifest-invalid',
    ],
  ])('As a dotli user, an app rejected for %s offers no retry', (_case, err, kind) => {
    const error = describeError(err, true);
    expect({ kind: error.kind, recovery: error.recovery }).toEqual({ kind, recovery: 'none' });
  });
});
