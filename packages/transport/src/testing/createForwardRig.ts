// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A three-party rig for tests of a call that crosses two channels.

import { createManualTimers } from '@dotli/shared/testing';
import { createTransport } from '../createTransport.js';
import { createProviderPair } from '../provider.fake.js';
import { RETRY_MS, TIMEOUT_MS } from './constants.js';
import { createIssueLog } from './createIssueLog.js';
import { testSchema } from './testSchema.js';

/**
 * A peer, a forwarder that serves it, the forwarder's upstream, and the server the upstream calls, over two in-memory
 * channels. The peer offers to the forwarder and the upstream to the server, and the forwarder forwards `notes.read`,
 * `notes.watch` and `echo.say` to the upstream before any call. `toForwarder` and `toUpstream` are what each channel
 * delivered, both ways.
 */
export function createForwardRig(schema: typeof testSchema = testSchema) {
  const near = createProviderPair();
  const far = createProviderPair();
  const timers = createManualTimers();
  const { issues, onIssue } = createIssueLog();
  const opening = { timers, retryMs: RETRY_MS, timeoutMs: TIMEOUT_MS, onIssue };
  const peer = createTransport({ schema, provider: near.left, handshake: 'offer', hello: 'peer', ...opening });
  const forwarder = createTransport({
    schema,
    provider: near.right,
    handshake: 'respond',
    hello: 'forwarder',
    onIssue,
  });
  const upstream = createTransport({ schema, provider: far.left, handshake: 'offer', hello: 'upstream', ...opening });
  const server = createTransport({ schema, provider: far.right, handshake: 'respond', hello: 'server', onIssue });
  const { read, watch } = schema.sections.notes;
  const stopForwarding = forwarder.forward([read, watch, schema.sections.echo.say], upstream);
  return {
    peer,
    forwarder,
    upstream,
    server,
    timers,
    issues,
    stopForwarding,
    toForwarder: near.delivered,
    toUpstream: far.delivered,
  };
}
