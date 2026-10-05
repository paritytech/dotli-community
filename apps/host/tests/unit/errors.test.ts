// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { setBackend } from '@dotli/config';
import { ProtocolInitFailedError } from '@dotli/protocol';

import { HOST_ERRORS } from '../../src/error-copy.js';
import { describeError } from '../../src/errors.js';
import { ManifestRejectedError } from '../../src/manifest-gate.js';

/** An error as the protocol client rebuilds it from a failed response. */
function crossedBoundary(message: string, name: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe('host error classification', () => {
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
        message: error.message,
        recovery: error.recovery,
        resetProtocol: error.resetProtocol,
      }).toEqual({
        kind: 'chain-halted',
        message: HOST_ERRORS.NETWORK_DROPPED,
        recovery: 'switch-backend',
        resetProtocol: undefined,
      });
    },
  );

  describe('a light client that failed to start', () => {
    const failed = (): ProtocolInitFailedError =>
      new ProtocolInitFailedError('SharedWorker: chain 0xaa connection failed');

    afterEach(() => {
      vi.unstubAllGlobals();
      localStorage.clear();
    });

    it('As a dotli user on the shared light client, it tells me to close my other dot.li tabs before I reload', () => {
      // Given
      vi.stubGlobal('SharedWorker', vi.fn());
      setBackend('smoldot-shared-worker');

      // When
      const error = describeError(failed(), true);

      // Then
      expect({ kind: error.kind, message: error.message, tips: error.tips }).toEqual({
        kind: 'protocol-init-failed',
        message: HOST_ERRORS.SW_FAILED_TO_START,
        tips: ['Closing other dot.li tabs, then reloading.', 'Checking your internet connection.'],
      });
    });

    it.each([
      ['smoldot-direct', true],
      ['rpc-gateway', false],
    ] as const)('As a dotli user on %s, it keeps only the connectivity tip', (backend, isP2p) => {
      // Given
      setBackend(backend);

      // When
      const error = describeError(failed(), isP2p);

      // Then
      expect({ kind: error.kind, tips: error.tips }).toEqual({
        kind: 'protocol-init-failed',
        tips: ['Checking your internet connection.'],
      });
    });
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
  ])('As a dotli user, an app rejected for %s says why and offers no retry', (_case, err, kind, message) => {
    // When
    const error = describeError(err, true);

    // Then
    expect({ kind: error.kind, title: error.title, message: error.message, recovery: error.recovery }).toEqual({
      kind,
      title: "This app can't be opened",
      message,
      recovery: 'none',
    });
    expect(error.tips).toEqual(['Contacting the app maintainer.']);
  });
});
