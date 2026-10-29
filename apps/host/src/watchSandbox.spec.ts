// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createManualTimers } from '@dotli/shared/testing';
import { SandboxSilentError, watchSandbox } from './watchSandbox.js';

/** The sandbox's messages, with how many listeners still hear them. */
type SandboxMessages = {
  onHeard: (listener: () => void) => () => void;
  /** Sends a message from the sandbox to every listener. */
  speak: () => void;
  /** Returns how many listeners still hear the sandbox. */
  countListening: () => number;
};

describe('watchSandbox', () => {
  it('As a visitor whose app frame starts, I wait past its message and the deadline passes with nothing left listening', async () => {
    // Given
    const timers = createManualTimers();
    const messages = createSandboxMessages();
    const watch = watchSandbox(messages.onHeard, { timers });
    const expected = watch.expectWithin(30_000);

    // When
    await timers.advance(29_999);
    messages.speak();

    // Then
    await expect(expected).resolves.toBeUndefined();
    expect(messages.countListening()).toBe(0);
  });

  it('As a visitor whose app frame spoke before the handoff ended, I wait out the deadline and that message counts', async () => {
    // Given the sandbox speaking before the deadline starts
    const timers = createManualTimers();
    const messages = createSandboxMessages();
    const watch = watchSandbox(messages.onHeard, { timers });
    messages.speak();

    // When
    const expected = watch.expectWithin(30_000);
    await timers.advance(30_000);

    // Then
    await expect(expected).resolves.toBeUndefined();
  });

  it('As a visitor whose app frame never starts, I wait out the deadline and the wait fails and stops listening', async () => {
    // Given
    const timers = createManualTimers();
    const messages = createSandboxMessages();
    const expected = watchSandbox(messages.onHeard, { timers }).expectWithin(30_000);
    const settled = expected.catch((error: unknown) => error);

    // When
    await timers.advance(30_000);

    // Then
    expect(await settled).toBeInstanceOf(SandboxSilentError);
    expect(messages.countListening()).toBe(0);
  });

  it('As a visitor whose load ended before the deadline was set, I leave and nothing is left listening to the app frame', () => {
    // Given
    const messages = createSandboxMessages();
    const watch = watchSandbox(messages.onHeard, { timers: createManualTimers() });

    // When
    watch.dispose();

    // Then
    expect(messages.countListening()).toBe(0);
  });
});

function createSandboxMessages(): SandboxMessages {
  const listeners = new Set<() => void>();
  return {
    onHeard(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    speak() {
      for (const listener of [...listeners]) {
        listener();
      }
    },
    countListening: () => listeners.size,
  };
}
