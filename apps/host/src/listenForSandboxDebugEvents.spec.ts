// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { BASE_DOMAIN, isSandboxOrigin } from '@dotli/config';
import { startSandboxChannel } from '@dotli/sandbox-wire';
import type { DotliDebugEvent } from '@dotli/truapi-debug';

import { listenForSandboxDebugEvents } from './listenForSandboxDebugEvents.js';
import { rethrow } from './testing/rethrow.js';

/** The host page's window as far as the relay hears it, and the debug bus the relay feeds. */
type RelayPage = {
  /** Every event that reached the debug bus, oldest first. */
  emitted: DotliDebugEvent[];
  /** Starts the relay as the host wires it, through the channel that checks the origin. Returns the stop. */
  startRelay: () => () => void;
  /** Posts the sandbox's document-written event to the page from `origin`. */
  postDebugEvent: (origin: string) => void;
};

const DOCUMENT_WRITTEN: DotliDebugEvent = {
  layer: 'sandbox',
  event: 'document_written',
  flowId: 'flow-1',
  timestamp: 1,
  payload: { cid: 'bafkreisandbox', totalMs: 120 },
};

describe('sandbox debug events', () => {
  it('As a developer, I watch the debug panel and the sandbox reports its progress into it', () => {
    // Given
    const { emitted, startRelay, postDebugEvent } = setupRelayPage();
    startRelay();

    // When
    postDebugEvent(`https://doom.app.${BASE_DOMAIN}`);

    // Then
    expect(emitted).toEqual([DOCUMENT_WRITTEN]);
  });

  it.each([
    ['another site', 'https://evil.example'],
    ['the host origin itself', `https://${BASE_DOMAIN}`],
    ['a look-alike of a sandbox origin', `https://doom.app.${BASE_DOMAIN}.evil.example`],
  ])('As a developer, I watch the debug panel and it ignores a sandbox debug event posted by %s', (_sender, origin) => {
    // Given
    const { emitted, startRelay, postDebugEvent } = setupRelayPage();
    startRelay();

    // When
    postDebugEvent(origin);

    // Then
    expect(emitted).toEqual([]);
  });

  it('As a developer, I stop the relay and later sandbox events no longer reach the debug panel', () => {
    // Given
    const { emitted, startRelay, postDebugEvent } = setupRelayPage();
    const stopRelay = startRelay();

    // When the relay stops, and the sandbox sends an event
    stopRelay();
    postDebugEvent(`https://doom.app.${BASE_DOMAIN}`);

    // Then
    expect(emitted).toEqual([]);
  });
});

/** Builds a page of its own whose channel stops when the case ends. */
function setupRelayPage(): RelayPage {
  const page = new EventTarget();
  const emitted: DotliDebugEvent[] = [];
  return {
    emitted,
    startRelay() {
      const channel = startSandboxChannel({ target: page, isTrustedOrigin: isSandboxOrigin, report: rethrow });
      onTestFinished(() => {
        channel.stop();
      });
      return listenForSandboxDebugEvents(channel, event => {
        emitted.push(event);
      });
    },
    postDebugEvent(origin) {
      page.dispatchEvent(
        new MessageEvent('message', { data: { type: 'dotli:debug-event', event: DOCUMENT_WRITTEN }, origin }),
      );
    },
  };
}
