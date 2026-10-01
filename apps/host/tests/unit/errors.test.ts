// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { ProtocolInitFailedError } from '@dotli/protocol';

import { describeError, HOST_ERRORS } from '../../src/errors.js';

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

  it('As a dotli user on the shared light client, a light client that failed to start tells me to close my other dot.li tabs before I reload', () => {
    // When
    const error = describeError(new ProtocolInitFailedError('SharedWorker: chain 0xaa connection failed'), true);

    // Then
    expect({ kind: error.kind, message: error.message, tips: error.tips }).toEqual({
      kind: 'protocol-init-failed',
      message: HOST_ERRORS.SW_FAILED_TO_START,
      tips: ['Close other dot.li tabs, then reload.', 'Checking your internet connection.'],
    });
  });
});
