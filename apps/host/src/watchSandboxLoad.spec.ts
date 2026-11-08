// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { startSandboxChannel, type SandboxChannel } from '@dotli/sandbox-wire';
import { createManualTimers } from '@dotli/shared/testing';
import { rethrow } from './testing/rethrow.js';
import { SandboxSilentError, watchSandboxLoad, type SandboxLoad } from './watchSandboxLoad.js';

const SANDBOX_ORIGIN = 'http://myapp.app.localhost:5173';

/** The sandbox's side of the channel, with how many listeners still hear it. */
type SandboxFrame = {
  channel: Pick<SandboxChannel, 'on'>;
  /** Posts a loading status to the page from the sandbox's origin. */
  postStatus: (status: Record<string, unknown>) => void;
  /** Returns how many listeners still hear the sandbox's loading status. */
  countListening: () => number;
};

describe('watchSandboxLoad', () => {
  it('As a visitor, I see my app frame say it starts and the load is heard', async () => {
    // Given
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers: createManualTimers() });

    // When
    frame.postStatus({ message: 'Starting' });

    // Then
    await expect(load.heard).resolves.toBeUndefined();
  });

  it('As a visitor, my app frame loads and I hear the outcome loaded and the screen cleared', async () => {
    // Given
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers: createManualTimers() });

    // When
    frame.postStatus({ done: true, outcome: 'loaded' });

    // Then
    await expect(load.cleared).resolves.toBeUndefined();
    await expect(load.outcome).resolves.toEqual({ outcome: 'loaded', failedStep: undefined });
  });

  it('As a visitor, my app frame fails at a step and I hear failed with that step', async () => {
    // Given
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers: createManualTimers() });

    // When
    frame.postStatus({ done: true, outcome: 'failed', failedStep: 'content_fetch' });

    // Then
    await expect(load.outcome).resolves.toEqual({ outcome: 'failed', failedStep: 'content_fetch' });
  });

  it('As a visitor, my app frame names a step that is not a token and I hear failed with no step', async () => {
    // Given
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers: createManualTimers() });

    // When
    frame.postStatus({ done: true, outcome: 'failed', failedStep: 'Failed: <script>' });

    // Then
    await expect(load.outcome).resolves.toEqual({ outcome: 'failed', failedStep: undefined });
  });

  it('As a visitor, my app frame clears the screen for its password prompt and later fails, and I hear the clear first and then failed with its step', async () => {
    // Given a watch that records what it hears, in order
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers: createManualTimers() });
    const heard = recordInOrder(load);

    // When the sandbox clears the screen for its prompt, then fails
    frame.postStatus({ done: true });
    await load.cleared;
    frame.postStatus({ done: true, outcome: 'failed', failedStep: 'archive_password' });
    await load.outcome;

    // Then
    expect(heard).toEqual(['cleared', { outcome: 'failed', failedStep: 'archive_password' }]);
  });

  it('As a visitor, my app frame reports twice and only the first outcome counts', async () => {
    // Given
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers: createManualTimers() });

    // When
    frame.postStatus({ done: true, outcome: 'loaded' });
    frame.postStatus({ done: true, outcome: 'failed', failedStep: 'content_fetch' });

    // Then the first outcome stands and nothing is left listening
    await expect(load.outcome).resolves.toEqual({ outcome: 'loaded', failedStep: undefined });
    expect(frame.countListening()).toBe(0);
  });

  it('As a visitor whose watch on the app frame stopped, I wait out the deadline and nothing the frame said after counts', async () => {
    // Given a watch stopped twice
    const timers = createManualTimers();
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers });
    load.dispose();
    load.dispose();

    // When the sandbox reports its outcome and the deadline passes
    frame.postStatus({ done: true, outcome: 'loaded' });
    const settled = load.expectHeardWithin().catch((error: unknown) => error);
    await timers.advance(30_000);

    // Then the load stays unheard and nothing is left listening
    expect(await settled).toBeInstanceOf(SandboxSilentError);
    expect(frame.countListening()).toBe(0);
  });

  it('As a visitor whose app frame never speaks, I wait out the deadline and the wait fails', async () => {
    // Given
    const timers = createManualTimers();
    const load = watchSandboxLoad(createSandboxFrame().channel, { timers });

    // When
    const settled = load.expectHeardWithin().catch((error: unknown) => error);
    await timers.advance(30_000);

    // Then
    expect(await settled).toBeInstanceOf(SandboxSilentError);
  });

  it('As a visitor whose app frame speaks during the wait, I wait and the wait resolves before the deadline', async () => {
    // Given a wait that has run to just short of its deadline
    const timers = createManualTimers();
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers });
    const expected = load.expectHeardWithin();
    await timers.advance(29_999);

    // When
    frame.postStatus({ message: 'Starting' });

    // Then
    await expect(expected).resolves.toBeUndefined();
  });

  it('As a visitor whose app frame spoke before the deadline started, I wait and the wait resolves at once', async () => {
    // Given the sandbox speaking before the deadline starts
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers: createManualTimers() });
    frame.postStatus({ message: 'Starting' });

    // When
    const expected = load.expectHeardWithin(30_000);

    // Then
    await expect(expected).resolves.toBeUndefined();
  });
});

function createSandboxFrame(): SandboxFrame {
  const page = new EventTarget();
  const started = startSandboxChannel({
    target: page,
    isTrustedOrigin: origin => origin === SANDBOX_ORIGIN,
    report: rethrow,
  });
  onTestFinished(() => {
    started.stop();
  });
  let listening = 0;
  return {
    channel: {
      on(type, handler) {
        listening += 1;
        const stop = started.on(type, handler);
        return () => {
          listening -= 1;
          stop();
        };
      },
    },
    postStatus(status) {
      page.dispatchEvent(
        new MessageEvent('message', { data: { type: 'dotli:loading-status', ...status }, origin: SANDBOX_ORIGIN }),
      );
    },
    countListening: () => listening,
  };
}

/** Records the clear and the outcome in the order they settle. */
function recordInOrder(load: SandboxLoad): unknown[] {
  const heard: unknown[] = [];
  void load.cleared.then(() => heard.push('cleared'));
  void load.outcome.then(report => heard.push(report));
  return heard;
}
