// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ChainAnnotations } from './decodeChainAnnotations.js';
import { formatChainOutcome } from './formatChainOutcome.js';

type OutcomeCase = {
  call: string;
  annotations: Pick<ChainAnnotations, 'outcome' | 'errorMessage'>;
  text: string | undefined;
};

const OUTCOME_CASES: OutcomeCase[] = [
  {
    call: 'failed with a message',
    annotations: { outcome: 'error', errorMessage: 'block pruned' },
    text: 'err: block pruned',
  },
  { call: 'failed with no message', annotations: { outcome: 'error' }, text: 'err: ?' },
  { call: 'hit the node limit', annotations: { outcome: 'limit-reached' }, text: 'limit-reached' },
  { call: 'succeeded', annotations: { outcome: 'ok' }, text: undefined },
  { call: 'started an operation', annotations: { outcome: 'started' }, text: undefined },
  { call: 'has no outcome yet', annotations: {}, text: undefined },
];

describe('formatChainOutcome', () => {
  it.each(OUTCOME_CASES)(
    'As a dotli developer, I read a chain call that $call and its short outcome is $text',
    ({ annotations, text }) => {
      // When
      const outcome = formatChainOutcome(annotations);

      // Then
      expect(outcome).toBe(text);
    },
  );
});
