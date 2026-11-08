// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { Backend } from '@dotli/config';
import { CONTENT_ERRORS } from '@dotli/content';
import { ProtocolInitFailedError, ProtocolVersionMismatchError } from '@dotli/protocol';
import { CHAIN_HALTED_ERROR_DATA, setErrorName } from '@dotli/shared';

import { HOST_ERRORS } from './errorCopy.js';
import { describeError } from './describeError.js';
import { ManifestRejectedError } from './manifestRejectedError.js';

describe('host error classification', () => {
  it.each([
    [
      'a gateway read its chain kept halting under',
      Object.assign(new Error('Chain transport halted'), { name: 'RpcError', data: CHAIN_HALTED_ERROR_DATA }),
    ],
    [
      'a light-client read its chain kept halting under',
      createCrossedError('Chain transport halted', 'ApiStoppedError'),
    ],
    ['a stopped client, whatever its text', createCrossedError('stopped', 'ApiStoppedError')],
  ])('As a dotli user, I see a resolution fail on %s and it says the network dropped', (_case, failure) => {
    // Given the row's halted read, from the table

    // When
    const described = describeError(failure);

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
  });

  it('As a dotli user beside an older protocol frame, I see a halted read that crossed by its text alone described as an unknown failure', () => {
    // Given a halted read that crossed from a frame that predates the typed halt
    const failure = createCrossedError('Chain transport halted', 'RpcError');

    // When
    const described = describeError(failure);

    // Then it reads as an unknown failure with the same recovery
    expect({ kind: described.kind, recovery: described.recovery }).toEqual({
      kind: 'unknown',
      recovery: 'switch-backend',
    });
  });

  it('As a user on an outdated page, I am told dot.li was updated and asked to reload', () => {
    // Given
    const mismatch = new ProtocolVersionMismatchError('The peer speaks wire version 2 and this end 1');

    // When
    const described = describeError(mismatch);

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
      const described = describeError(createInitFailure(), { readBackend: () => 'smoldot-shared-worker' });

      // Then
      expect({ kind: described.kind, message: described.message, tips: described.tips }).toEqual({
        kind: 'protocol-init-failed',
        message: HOST_ERRORS.SW_FAILED_TO_START,
        tips: ['Closing other dot.li tabs, then reloading.', 'Checking your internet connection.'],
      });
    });

    it.each(['smoldot-direct', 'rpc-gateway'] as const)(
      'As a dotli user on %s, I see the light client fail to start and get only the connectivity tip',
      backend => {
        // When
        const described = describeError(createInitFailure(), { readBackend: () => backend });

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
      const described = describeError(rejection);

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

  it.each([
    [
      'the named unreachable gateway',
      setErrorName(new Error('IPFS gateway gw.example unreachable for bafy'), CONTENT_ERRORS.GATEWAY_UNREACHABLE),
      'failed-to-fetch',
    ],
    [
      'a chunk that failed to load',
      new TypeError('Failed to fetch dynamically imported module: https://x.example/a.js'),
      'module-fetch-failed',
    ],
    ['a raw browser fetch failure', new TypeError('Failed to fetch'), 'unknown'],
  ])('As a dotli user on the gateway backend, I hit %s and get its own error kind', (_case, failure, kind) => {
    // Given a visitor on the gateway backend
    const context = { readBackend: () => 'rpc-gateway' as const };

    // When the failure is described
    const described = describeError(failure, context);

    // Then it gets the error kind of its own cause
    expect(described.kind).toBe(kind);
  });

  it.each<{ backend: Backend; failure: string; error: Error; tip: string }>([
    {
      backend: 'rpc-gateway',
      failure: 'the named unreachable gateway',
      error: setErrorName(
        new Error('IPFS gateway gw.example unreachable for bafy'),
        CONTENT_ERRORS.GATEWAY_UNREACHABLE,
      ),
      tip: 'Switching Network transport to "Light client shared" in Settings.',
    },
    {
      backend: 'rpc-gateway',
      failure: 'a truncated archive',
      error: new Error('Unexpected end of data'),
      tip: 'Switching Network transport to "Light client shared" in Settings.',
    },
    {
      backend: 'smoldot-direct',
      failure: 'a truncated archive',
      error: new Error('Unexpected end of data'),
      tip: 'Switching Network transport to "Trusted providers" in Settings.',
    },
  ])(
    'As a dotli user on $backend, I hit $failure and the tip offers the backend a failover would switch to',
    ({ backend, error, tip }) => {
      // Given a visitor on that backend
      const context = { readBackend: () => backend };

      // When the failure is described
      const described = describeError(error, context);

      // Then the first tip names the backend a failover switches to
      expect(described.tips[0]).toBe(tip);
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
