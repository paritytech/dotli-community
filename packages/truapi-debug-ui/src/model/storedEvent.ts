// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Events are never mutated after insertion.

import type { TruapiDebugMessageEvent } from '@dotli/truapi-debug';
import type { SystemEventPair } from './getSystemEventKey.js';

/** Monotonic, assigned at insertion. */
export type EventSeq = number;

export type StoredTruapiEvent = {
  kind: 'truapi';
  seq: EventSeq;
  receivedAt: number;
  direction: TruapiDebugMessageEvent['direction'];
  productId: string | undefined;
  requestId: string;
  tag: string;
  payload: unknown;
};

export type StoredSystemEvent = {
  kind: 'system';
  seq: EventSeq;
  receivedAt: number;
  source: 'dotli';
  flowId: string;
  payload: unknown;
} & SystemEventPair;

export type StoredEvent = StoredTruapiEvent | StoredSystemEvent;
