// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { describeError } from '../../src/errors.js';

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
});
