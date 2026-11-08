// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SystemEventPair } from './getSystemEventKey.js';
import { findSystemEventFacts, type SystemExplanation } from './systemEventFacts.js';

/** The longer explanation of the host event `pair`, or undefined for an event the union does not name. Never throws. */
export function getSystemExplanation(pair: SystemEventPair): SystemExplanation | undefined {
  return findSystemEventFacts(pair)?.explanation;
}
