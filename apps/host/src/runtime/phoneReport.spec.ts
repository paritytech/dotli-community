// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { recordLog } from '@dotli/shared/testing';
import { reportPhoneEnd, type PhoneEnd } from './phoneReport.js';
import { bindReports } from '../testing/bindReports.js';

describe('reportPhoneEnd', () => {
  it('As an operator, I see a phone request whose notice throws captured and counted under the notice metric', () => {
    // Given a rejected request and a toast that throws
    const { captures, counted } = bindReports();
    recordLog({ onFinished: onTestFinished, level: 'error' });
    const end: PhoneEnd = {
      method: 'signRaw',
      outcome: { kind: 'rejected' },
      background: false,
      title: 'Sign Message',
      app: 'example.dot',
    };
    const failure = new TypeError('toast broke');

    // When the request's end is reported
    reportPhoneEnd(end, () => {
      throw failure;
    });

    // Then the throw is captured once and counted under the notice metric, and the request's end is still counted
    expect(captures.exception.mock.calls).toEqual([
      [failure, { flow: 'wallet', step: 'phone_request_notice', tags: { method: 'signRaw' } }],
    ]);
    expect(counted('signing.phone_request_notice')).toEqual([
      { outcome: 'error', reason: 'TypeError', method: 'signRaw' },
    ]);
    expect(counted('signing.phone_request')).toEqual([{ outcome: 'refused', reason: 'signRaw', background: 'no' }]);
  });
});
