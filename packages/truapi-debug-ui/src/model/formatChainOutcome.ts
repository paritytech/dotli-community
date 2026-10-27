// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChainAnnotations, ChainOutcome } from './decodeChainAnnotations.js';

/**
 * The short form of a chain call's outcome: `err: <message>` (or `err: ?`) for an error, `limit-reached`, or nothing.
 * Never throws.
 */
export function formatChainOutcome(
  annotations: Pick<ChainAnnotations, 'outcome' | 'errorMessage'>,
): string | undefined {
  // Typed so `case undefined` also covers an absent outcome, which exact optional property types keep apart.
  const outcome: ChainOutcome | undefined = annotations.outcome;
  switch (outcome) {
    case 'error':
      return `err: ${annotations.errorMessage ?? '?'}`;
    case 'limit-reached':
      return 'limit-reached';
    case 'ok':
    case 'started':
    case undefined:
      return undefined;
  }
}
