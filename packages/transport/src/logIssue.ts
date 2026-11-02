// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { log } from '@dotli/shared';
import { describeIssue, type TransportIssue } from './describeIssue.js';

// One log line per issue, enough to tell issues apart.
const MAX_LOG_CHARS = 200;

/** The issue hook of a transport whose owner sets none. */
export function logIssue(issue: TransportIssue): void {
  log.error(`[transport] ${describeIssue(issue)}`.slice(0, MAX_LOG_CHARS));
}
