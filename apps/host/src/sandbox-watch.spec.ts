// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { manualTimers } from '@dotli/shared/testing';
import { SandboxSilentError, watchSandbox } from './sandbox-watch.js';

/** The sandbox's messages, with how many listeners still hear them. */
function sandboxMessages() {
  const listeners = new Set<() => void>();
  return {
    onHeard: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    speak: () => {
      for (const listener of [...listeners]) {
        listener();
      }
    },
    listening: () => listeners.size,
  };
}

describe('watchSandbox', () => {
  it('As a visitor whose app frame starts, the deadline passes and nothing is left listening', async () => {
    // Given
    const timers = manualTimers();
    const messages = sandboxMessages();
    const watch = watchSandbox(messages.onHeard, timers);
    const expected = watch.expectWithin(30_000);

    // When
    await timers.advance(29_999);
    messages.speak();

    // Then
    await expect(expected).resolves.toBeUndefined();
    expect(messages.listening()).toBe(0);
  });

  it('As a visitor whose app frame spoke before the handoff ended, that message counts', async () => {
    // Given the sandbox speaking before the deadline starts
    const timers = manualTimers();
    const messages = sandboxMessages();
    const watch = watchSandbox(messages.onHeard, timers);
    messages.speak();

    // When
    const expected = watch.expectWithin(30_000);
    await timers.advance(30_000);

    // Then
    await expect(expected).resolves.toBeUndefined();
  });

  it('As a visitor whose app frame never starts, the wait fails after its deadline and stops listening', async () => {
    // Given
    const timers = manualTimers();
    const messages = sandboxMessages();
    const expected = watchSandbox(messages.onHeard, timers).expectWithin(30_000);
    const settled = expected.catch((error: unknown) => error);

    // When
    await timers.advance(30_000);

    // Then
    expect(await settled).toBeInstanceOf(SandboxSilentError);
    expect(messages.listening()).toBe(0);
  });
});
