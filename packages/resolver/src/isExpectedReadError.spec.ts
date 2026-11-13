// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { DisjointError, OperationInaccessibleError, OperationLimitError } from '@polkadot-api/substrate-client';
import { CHAIN_HALTED_ERROR_DATA } from '@dotli/shared';
import { ApiStoppedError } from './apiStoppedError.js';
import { isExpectedReadError } from './isExpectedReadError.js';
import { NetworkSyncTimeoutError } from './networkSyncTimeoutError.js';

describe('isExpectedReadError', () => {
  it.each([
    { failure: 'times out', error: new NetworkSyncTimeoutError('Asset Hub', 1000) },
    { failure: 'finds no peer to serve it', error: new OperationInaccessibleError() },
    { failure: 'is refused for the operation limit', error: new OperationLimitError() },
    { failure: 'runs on a follow gone disjoint', error: new DisjointError() },
    { failure: 'reads after its follow stopped', error: new ApiStoppedError() },
    {
      failure: 'reads a chain that kept halting',
      error: Object.assign(new Error('chain halted'), { data: CHAIN_HALTED_ERROR_DATA }),
    },
  ])('As a caller whose read $failure, I take the failure as expected', ({ error }) => {
    // When
    const expected = isExpectedReadError(error);

    // Then
    expect(expected).toBe(true);
  });

  it('As a caller whose read fails in the code, I take the failure as a defect', () => {
    // When
    const expected = isExpectedReadError(new TypeError('bad slot'));

    // Then
    expect(expected).toBe(false);
  });
});
