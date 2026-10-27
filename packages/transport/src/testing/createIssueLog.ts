// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Collects issues so a test asserts on what a transport reported.

import type { TransportIssue } from '../describeIssue.js';

/** Records every issue a transport hands its owner. */
export function createIssueLog() {
  const issues: TransportIssue[] = [];
  return { issues, onIssue: (issue: TransportIssue) => issues.push(issue) };
}
