// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import {
  parseHostToSandboxMessage,
  parseSandboxToHostMessage,
  postToHost,
  type SandboxToHostMessage,
} from './sandbox-messages.js';

// Literal copies of what a deployed sandbox and host post, so a release that changes the wire fails here.
const SANDBOX_SENDS: [string, SandboxToHostMessage][] = [
  ['progress text', { type: 'dotli:loading-status', message: 'Fetching via bitswap...' }],
  ['a loaded content', { type: 'dotli:loading-status', done: true, outcome: 'loaded' }],
  ['a failed load', { type: 'dotli:loading-status', done: true, outcome: 'failed', failedStep: 'content_fetch' }],
  ['an early prompt', { type: 'dotli:loading-status', done: true }],
  [
    'a debug event',
    {
      type: 'dotli:debug-event',
      event: { layer: 'sandbox', event: 'document_written', flowId: 'f-1', timestamp: 1, payload: { cid: 'bafy' } },
    },
  ],
  ['a recover request', { type: 'dotli:sandbox-recover' }],
  ['a block request', { type: 'dotli:bitswap-get', id: 'bitswap-1-1', cid: 'bafyX' }],
  ['a teardown abort', { type: 'dotli:bitswap-abort', ids: ['bitswap-1-1'] }],
  ['a block request from a named frame', { type: 'dotli:bitswap-get', id: 'bitswap-1-1', cid: 'bafyX', frame: 'f-1' }],
  ['a teardown abort from a named frame', { type: 'dotli:bitswap-abort', ids: ['bitswap-1-1'], frame: 'f-1' }],
];

describe('sandbox messages', () => {
  it.each(SANDBOX_SENDS)('As the host, I read %s from the sandbox exactly as it was sent', (_name, sent) => {
    // When
    const received = parseSandboxToHostMessage(structuredClone(sent));

    // Then
    expect(received).toEqual(sent);
  });

  it.each([
    ['a non-object', 'dotli:loading-status'],
    ['an unknown type', { type: 'dotli:unknown' }],
    ['a block request without a CID', { type: 'dotli:bitswap-get', id: 'r-1', cid: '' }],
    ['an abort with a non-string id', { type: 'dotli:bitswap-abort', ids: [1] }],
    ['a debug event from another layer', { type: 'dotli:debug-event', event: { layer: 'main' } }],
  ])('As the host, I drop %s', (_name, data) => {
    // When
    const received = parseSandboxToHostMessage(data);

    // Then
    expect(received).toBeNull();
  });

  it('As the host, I keep only the loading status fields with the types I expect', () => {
    // When
    const received = parseSandboxToHostMessage({
      type: 'dotli:loading-status',
      done: 'yes',
      outcome: 'exploded',
      failedStep: 42,
    });

    // Then
    expect(received).toEqual({ type: 'dotli:loading-status' });
  });

  it('As the sandbox, I read a block the host fetched with its bytes', () => {
    // Given
    const bytes = new Uint8Array([1, 2]);

    // When
    const received = parseHostToSandboxMessage({ type: 'dotli:bitswap-result', id: 'r-1', ok: true, bytes });

    // Then
    expect(received).toEqual({ type: 'dotli:bitswap-result', id: 'r-1', ok: true, bytes });
  });

  it('As the sandbox, I read a failed fetch with its error class and code', () => {
    // When
    const received = parseHostToSandboxMessage({
      type: 'dotli:bitswap-result',
      id: 'r-1',
      ok: false,
      error: 'provider discovery exhausted',
      errorName: 'BitswapNotFoundError',
      code: -32810,
    });

    // Then
    expect(received).toEqual({
      type: 'dotli:bitswap-result',
      id: 'r-1',
      ok: false,
      error: 'provider discovery exhausted',
      errorName: 'BitswapNotFoundError',
      code: -32810,
    });
  });

  it('As the sandbox, I read a success without bytes as a failure', () => {
    // When
    const received = parseHostToSandboxMessage({ type: 'dotli:bitswap-result', id: 'r-1', ok: true });

    // Then
    expect(received).toEqual({ type: 'dotli:bitswap-result', id: 'r-1', ok: false });
  });

  it('As the sandbox, I drop a result without an id', () => {
    // When
    const received = parseHostToSandboxMessage({ type: 'dotli:bitswap-result', ok: true });

    // Then
    expect(received).toBeNull();
  });

  it('As the sandbox, I post to my host whatever its origin', () => {
    // Given
    const posted: [unknown, string][] = [];
    const host = {
      postMessage: (message: unknown, targetOrigin: string) => {
        posted.push([message, targetOrigin]);
      },
    } as Pick<Window, 'postMessage'>;

    // When
    postToHost(host, { type: 'dotli:sandbox-recover' });

    // Then
    expect(posted).toEqual([[{ type: 'dotli:sandbox-recover' }, '*']]);
  });
});
