// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { spans as S, type m } from '@dotli/metrics';
import type { CallName } from '@dotli/protocol';
import { createRefusalReporter } from './createRefusalReporter.js';
import type { FrameRefusal, FrameRoute } from './withRefusalReports.js';

type Row = {
  refusal: FrameRefusal;
  warned: unknown[][];
  counted: unknown[][];
};

const FAILURE = new Error('storage read failed');

const FAILED_METHODS: Record<FrameRoute, CallName> = {
  auth: 'authStorageWrite',
  mode: 'modeStorageWrite',
  wallet: 'localWalletRead',
  chain: 'resolveDotName',
};

/** A refusal of the route, as its handler failed. */
function toRefusal(route: FrameRoute): FrameRefusal {
  return { route, method: FAILED_METHODS[route], error: FAILURE };
}

const TABLE: Row[] = [
  {
    refusal: toRefusal('auth'),
    warned: [],
    counted: [[S.SHARED_STORAGE_REJECTED, { store: 'auth', reason: 'validation' }]],
  },
  {
    refusal: toRefusal('mode'),
    warned: [],
    counted: [[S.SHARED_STORAGE_REJECTED, { store: 'mode', reason: 'validation' }]],
  },
  { refusal: toRefusal('wallet'), warned: [['[dot.li protocol] localWalletRead failed', FAILURE]], counted: [] },
  { refusal: toRefusal('chain'), warned: [['[dot.li protocol] resolveDotName failed', FAILURE]], counted: [] },
];

/** A log and a counter that keep what they were handed. */
function createRecordingSinks() {
  const warned: unknown[][] = [];
  const counted: unknown[][] = [];
  return {
    /** The arguments of each line logged, in order. */
    warned,
    /** The name and attributes of each count, in order. */
    counted,
    /** Keeps a logged line. Never throws. */
    warn(...args: unknown[]): void {
      warned.push(args);
    },
    /** Keeps a count. Never throws. */
    count(name: string, attributes?: Parameters<typeof m.count>[1]): void {
      counted.push([name, attributes]);
    },
  };
}

describe('the protocol frame refusal report', () => {
  it.each(TABLE)(
    'As a dotli operator, I watch a $refusal.route call fail and see it logged and counted as its route says',
    row => {
      // Given a reporter on its own log and counter
      const sinks = createRecordingSinks();
      const report = createRefusalReporter(sinks);

      // When one call is refused
      report(row.refusal);

      // Then it is logged and counted as the table says
      expect({ warned: sinks.warned, counted: sinks.counted }).toEqual({ warned: row.warned, counted: row.counted });
    },
  );
});
