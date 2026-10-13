// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { reportSandboxHandlerFailure } from './sandbox-handler.js';

describe('reportSandboxHandlerFailure', () => {
  it('As an operator, a sandbox message handler that throws is captured with its message type and counted by its cause', () => {
    // Given a reporting pipeline that records captures and counts
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const { counted } = bindRecordingSentry({ onFinished: onTestFinished });
    const failure = new TypeError('handler broke');

    // When
    reportSandboxHandlerFailure(failure, 'dotli:bitswap-get');

    // Then one issue names the handler, and one count names the cause
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(failure, {
      flow: 'ui',
      step: 'sandbox_handler',
      tags: { type: 'dotli:bitswap-get' },
    });
    expect(counted('sandbox.handler')).toContainEqual({ outcome: 'error', reason: 'TypeError' });
  });
});
