// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { BASE_DOMAIN, isSandboxOrigin } from '@dotli/config';
import { startSandboxChannel, type StartedSandboxChannel } from '@dotli/sandbox-wire';
import type { DotliDebugEvent } from '@dotli/truapi-debug';

import { listenForSandboxDebugEvents } from './sandbox-debug-events.js';

/** A handler that throws fails the test. */
const rethrow = (error: unknown): never => {
  throw error;
};

const SANDBOX_STARTED: DotliDebugEvent = {
  layer: 'sandbox',
  event: 'started',
  flowId: 'flow-1',
  timestamp: 1,
  payload: { cid: 'bafkreisandbox', contentBackend: 'rpc-gateway' },
};

/** The host page's window, as far as the channel listens on it. */
const page = new EventTarget();

function postDebugEvent(origin: string): void {
  page.dispatchEvent(
    new MessageEvent('message', { data: { type: 'dotli:debug-event', event: SANDBOX_STARTED }, origin }),
  );
}

/** Stands in for the debug bus, keeping what reached it. */
function debugBus(): { emitted: DotliDebugEvent[]; emit: (event: DotliDebugEvent) => void } {
  const emitted: DotliDebugEvent[] = [];
  return {
    emitted,
    emit: event => {
      emitted.push(event);
    },
  };
}

let channel: StartedSandboxChannel | null = null;

/** As the host wires it: the relay hears the sandbox through the channel, which checks the origin. */
function startRelay(emit: (event: DotliDebugEvent) => void): () => void {
  channel = startSandboxChannel({ target: page, isTrustedOrigin: isSandboxOrigin, report: rethrow });
  return listenForSandboxDebugEvents(channel, emit);
}

afterEach(() => {
  channel?.stop();
  channel = null;
});

describe('sandbox debug events', () => {
  it('As a developer, I watch the debug panel and the sandbox reports its progress into it', () => {
    // Given
    const bus = debugBus();
    startRelay(bus.emit);

    // When
    postDebugEvent(`https://doom.app.${BASE_DOMAIN}`);

    // Then
    expect(bus.emitted).toEqual([SANDBOX_STARTED]);
  });

  it.each([
    ['another site', 'https://evil.example'],
    ['the host origin itself', `https://${BASE_DOMAIN}`],
    ['a look-alike of a sandbox origin', `https://doom.app.${BASE_DOMAIN}.evil.example`],
  ])('As a developer, I watch the debug panel and it ignores a sandbox debug event posted by %s', (_sender, origin) => {
    // Given
    const bus = debugBus();
    startRelay(bus.emit);

    // When
    postDebugEvent(origin);

    // Then
    expect(bus.emitted).toEqual([]);
  });

  it('As a developer, I stop the relay and later sandbox events no longer reach the debug panel', () => {
    // Given
    const bus = debugBus();
    startRelay(bus.emit)();

    // When
    postDebugEvent(`https://doom.app.${BASE_DOMAIN}`);

    // Then
    expect(bus.emitted).toEqual([]);
  });
});
