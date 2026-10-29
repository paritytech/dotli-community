// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { ProtocolInitFailedError, ProtocolVersionMismatchError } from '@dotli/protocol';

import { HOST_ERRORS } from './errorCopy.js';
import { describeError } from './describeError.js';
import { ManifestRejectedError } from './manifestRejectedError.js';

describe('host error classification', () => {
  it.each([
    ['the halted answer to a read in flight', createCrossedError('Chain transport halted', 'RpcError')],
    [
      'a follow that stopped',
      createCrossedError('chainHead follow stopped (cause: ChainHead stopped)', 'ProtocolResponseError'),
    ],
    ['a stopped client, whatever its text', createCrossedError('stopped', 'ApiStoppedError')],
  ])(
    'As a dotli user on a light client, I see a resolution fail on %s and it says the network dropped',
    (_case, failure) => {
      // When
      const described = describeError(failure, { isP2p: true });

      // Then
      expect({
        kind: described.kind,
        message: described.message,
        recovery: described.recovery,
        resetProtocol: described.resetProtocol,
      }).toEqual({
        kind: 'chain-halted',
        message: HOST_ERRORS.NETWORK_DROPPED,
        recovery: 'switch-backend',
        resetProtocol: undefined,
      });
    },
  );

  it('As a user on an outdated page, I am told dot.li was updated and asked to reload', () => {
    // Given
    const mismatch = new ProtocolVersionMismatchError('The peer speaks wire version 2 and this end 1');

    // When
    const described = describeError(mismatch, { isP2p: true });

    // Then
    expect({ kind: described.kind, message: described.message, recovery: described.recovery }).toEqual({
      kind: 'protocol-version-mismatch',
      message: HOST_ERRORS.PROTOCOL_UPDATED,
      recovery: 'reload',
    });
  });

  describe('a light client that failed to start', () => {
    it('As a dotli user on the shared light client, I see it fail to start and am told to close my other dot.li tabs before I reload', () => {
      // When
      const described = describeError(createInitFailure(), {
        isP2p: true,
        readBackend: () => 'smoldot-shared-worker',
      });

      // Then
      expect({ kind: described.kind, message: described.message, tips: described.tips }).toEqual({
        kind: 'protocol-init-failed',
        message: HOST_ERRORS.SW_FAILED_TO_START,
        tips: ['Closing other dot.li tabs, then reloading.', 'Checking your internet connection.'],
      });
    });

    it.each([
      ['smoldot-direct', true],
      ['rpc-gateway', false],
    ] as const)(
      'As a dotli user on %s, I see the light client fail to start and get only the connectivity tip',
      (backend, isP2p) => {
        // When
        const described = describeError(createInitFailure(), { isP2p, readBackend: () => backend });

        // Then
        expect({ kind: described.kind, tips: described.tips }).toEqual({
          kind: 'protocol-init-failed',
          tips: ['Checking your internet connection.'],
        });
      },
    );
  });

  it.each([
    [
      'a manifest version this host does not read',
      new ManifestRejectedError('unsupported-version', 'app', '$v 2'),
      'manifest-unsupported-version',
      HOST_ERRORS.MANIFEST_UNSUPPORTED_VERSION,
    ],
    [
      'an invalid manifest',
      new ManifestRejectedError('invalid', 'root', 'root manifest displayName must be a non-empty string'),
      'manifest-invalid',
      HOST_ERRORS.MANIFEST_INVALID,
    ],
    [
      'an app manifest without a root manifest',
      new ManifestRejectedError('missing-root', 'root', 'no root manifest'),
      'manifest-invalid',
      HOST_ERRORS.MANIFEST_INVALID,
    ],
  ])(
    'As a dotli user, I open an app rejected for %s and am told why with no retry',
    (_case, rejection, kind, message) => {
      // When
      const described = describeError(rejection, { isP2p: true });

      // Then
      expect({
        kind: described.kind,
        title: described.title,
        message: described.message,
        recovery: described.recovery,
      }).toEqual({
        kind,
        title: "This app can't be opened",
        message,
        recovery: 'none',
      });
      expect(described.tips).toEqual(['Contacting the app maintainer.']);
    },
  );
});

/** Returns an error as the protocol client rebuilds it from a failed response. */
function createCrossedError(message: string, name: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function createInitFailure(): ProtocolInitFailedError {
  return new ProtocolInitFailedError('SharedWorker: chain 0xaa connection failed');
}
