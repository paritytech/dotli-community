// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { setBackend } from '@dotli/config';
import { ProtocolInitFailedError } from '@dotli/protocol';

import { describeError, HOST_ERRORS } from '../../src/errors.js';

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
});
