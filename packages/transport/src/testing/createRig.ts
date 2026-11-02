// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The two-sided rig most specs open their calls on.

import { createManualTimers } from '@dotli/shared/testing';
import { createTransport } from '../createTransport.js';
import { createProviderPair } from '../provider.fake.js';
import { RETRY_MS, TIMEOUT_MS } from './constants.js';
import { createIssueLog } from './createIssueLog.js';
import { testSchema } from './testSchema.js';

/** An opener on the left and an accepter on the right, over one in-memory channel. */
export function createRig() {
  const { left, right, delivered } = createProviderPair();
  const timers = createManualTimers();
  const { issues, onIssue } = createIssueLog();
  const opener = createTransport({
    schema: testSchema,
    provider: left,
    handshake: 'offer',
    hello: 'opener',
    timers,
    retryMs: RETRY_MS,
    timeoutMs: TIMEOUT_MS,
    onIssue,
  });
  const accepter = createTransport({
    schema: testSchema,
    provider: right,
    handshake: 'respond',
    hello: 'accepter',
    onIssue,
  });
  return { opener, accepter, timers, issues, delivered, left, right };
}
