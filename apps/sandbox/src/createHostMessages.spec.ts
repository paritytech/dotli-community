// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createManualTimers } from '@dotli/shared/testing';

import { createHostMessages } from './createHostMessages.js';

/** The host page, keeping each message posted to it and the origin it was posted for. */
function createRecordingParent() {
  const posted: { message: unknown; targetOrigin: unknown }[] = [];
  return {
    posted,
    postMessage: (message: unknown, targetOrigin?: unknown) => {
      posted.push({ message, targetOrigin });
    },
  };
}

describe('host messages', () => {
  it("As the sandbox's integrator, I report a load's progress and its end, and the host's loading screen gets each in order", () => {
    // Given
    const parent = createRecordingParent();
    const hostMessages = createHostMessages({ parent, timers: createManualTimers() });

    // When
    hostMessages.showStatus('Fetching via bitswap...');
    hostMessages.dismissLoading();
    hostMessages.notifyLoadingDone({ outcome: 'failed', failedStep: 'content_fetch' });
    hostMessages.notifyLoadingDone({ outcome: 'loaded' });

    // Then
    expect(parent.posted).toEqual([
      { message: { type: 'dotli:loading-status', message: 'Fetching via bitswap...' }, targetOrigin: '*' },
      { message: { type: 'dotli:loading-status', done: true }, targetOrigin: '*' },
      {
        message: { type: 'dotli:loading-status', done: true, outcome: 'failed', failedStep: 'content_fetch' },
        targetOrigin: '*',
      },
      { message: { type: 'dotli:loading-status', done: true, outcome: 'loaded' }, targetOrigin: '*' },
    ]);
  });

  it("As the sandbox's integrator, I report a debug event and the host's debug bus gets it stamped with the clock's time", () => {
    // Given
    const parent = createRecordingParent();
    const hostMessages = createHostMessages({ parent, timers: createManualTimers({ start: 1_700_000_000_000 }) });

    // When
    hostMessages.reportDebug({ event: 'document_written', flowId: 'r1', payload: { bytes: 12 } });

    // Then
    expect(parent.posted).toEqual([
      {
        message: {
          type: 'dotli:debug-event',
          event: {
            layer: 'sandbox',
            event: 'document_written',
            flowId: 'r1',
            timestamp: 1_700_000_000_000,
            payload: { bytes: 12 },
          },
        },
        targetOrigin: '*',
      },
    ]);
  });

  it("As a visitor, I reload the product's page and the sandbox asks the host to render it again and says so", () => {
    // Given
    const parent = createRecordingParent();
    const hostMessages = createHostMessages({ parent, timers: createManualTimers() });

    // When
    hostMessages.askRerender();

    // Then
    expect(parent.posted).toEqual([
      { message: { type: 'dotli:loading-status', message: 'Restoring app...' }, targetOrigin: '*' },
      { message: { type: 'dotli:sandbox-recover' }, targetOrigin: '*' },
    ]);
  });
});
