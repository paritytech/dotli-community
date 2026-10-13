// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { spans as S } from '@dotli/metrics';
import type { ProtocolRequestEnvelope } from '@dotli/protocol';
import type { FrameRefusal, FrameRoute } from './frame-router.js';
import { createRefusalReporter } from './refusal-report.js';

const STRANGER = 'https://evil.example';
const FAILURE = new Error('storage read failed');

function request(method: ProtocolRequestEnvelope['method']): ProtocolRequestEnvelope {
  return { namespace: 'dotli:protocol', kind: 'request', id: 'r1', method, payload: {} };
}

const failedMethods: Record<FrameRoute, ProtocolRequestEnvelope['method']> = {
  auth: 'authStorageWrite',
  mode: 'modeStorageWrite',
  wallet: 'localWalletRead',
  chain: 'resolveDotName',
};

interface Row {
  refusal: FrameRefusal;
  warned: unknown[][];
  counted: unknown[][];
}

const origin = (route: FrameRoute): FrameRefusal => ({ route, reason: 'origin', origin: STRANGER });
const failed = (route: FrameRoute): FrameRefusal => ({
  route,
  reason: 'failed',
  request: request(failedMethods[route]),
  error: FAILURE,
});

const TABLE: Row[] = [
  {
    refusal: origin('auth'),
    warned: [[`[dot.li protocol] Rejected shared-auth request from disallowed origin: ${STRANGER}`]],
    counted: [[S.SHARED_STORAGE_REJECTED, { store: 'auth', reason: 'origin' }]],
  },
  {
    refusal: origin('mode'),
    warned: [[`[dot.li protocol] Rejected shared-mode request from disallowed origin: ${STRANGER}`]],
    counted: [[S.SHARED_STORAGE_REJECTED, { store: 'mode', reason: 'origin' }]],
  },
  {
    refusal: origin('wallet'),
    warned: [[`[dot.li protocol] Rejected local wallet request from disallowed origin: ${STRANGER}`]],
    counted: [[S.SHARED_STORAGE_REJECTED, { store: 'wallet', reason: 'origin' }]],
  },
  {
    refusal: origin('chain'),
    warned: [[`[dot.li protocol] Rejected request from disallowed origin: ${STRANGER}`]],
    counted: [],
  },
  {
    refusal: failed('auth'),
    warned: [],
    counted: [[S.SHARED_STORAGE_REJECTED, { store: 'auth', reason: 'validation' }]],
  },
  {
    refusal: failed('mode'),
    warned: [],
    counted: [[S.SHARED_STORAGE_REJECTED, { store: 'mode', reason: 'validation' }]],
  },
  { refusal: failed('wallet'), warned: [['[dot.li protocol] localWalletRead failed', FAILURE]], counted: [] },
  { refusal: failed('chain'), warned: [['[dot.li protocol] resolveDotName failed', FAILURE]], counted: [] },
];

describe('the protocol frame refusal report', () => {
  it('As a dotli operator, I see each refused request logged and counted by its route and reason', () => {
    for (const row of TABLE) {
      // Given a reporter on its own log and counter
      const warned: unknown[][] = [];
      const counted: unknown[][] = [];
      const report = createRefusalReporter({
        warn: (...args) => warned.push(args),
        count: (name, attributes) => counted.push([name, attributes]),
      });

      // When the router refuses one request
      report(row.refusal);

      // Then it is logged and counted as the table says
      expect({ refusal: row.refusal, warned, counted }).toEqual(row);
    }
  });
});
