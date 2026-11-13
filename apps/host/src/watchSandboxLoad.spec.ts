// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { startSandboxChannel, type SandboxChannel } from '@dotli/sandbox-wire';
import { createManualTimers } from '@dotli/shared/testing';
import { bindReports } from './testing/bindReports.js';
import { rethrow } from './testing/rethrow.js';
import { SandboxSilentError, watchSandboxLoad, type SandboxLoad, type SandboxLoadReport } from './watchSandboxLoad.js';

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
  it('As a visitor, I see my app frame say it starts and the loading screen is not cleared yet', () => {
    // Given a follower of the screen's clear
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers: createManualTimers() });
    const heard: string[] = [];
    load.subscribeCleared(() => heard.push('cleared'));

    // When
    frame.postStatus({ message: 'Starting' });

    // Then
    expect(heard).toEqual([]);
  });

  it('As a visitor, my app frame loads and I hear the outcome loaded and the screen cleared', () => {
    // Given
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers: createManualTimers() });
    const heard = recordInOrder(load);

    // When
    frame.postStatus({ done: true, outcome: 'loaded' });

    // Then
    expect(heard).toEqual(['cleared', { outcome: 'loaded', failedStep: undefined }]);
  });

  it('As a visitor, my app frame fails at a step and I hear failed with that step', () => {
    // Given
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers: createManualTimers() });
    const heard: SandboxLoadReport[] = [];
    load.subscribeOutcomes(report => heard.push(report));

    // When
    frame.postStatus({ done: true, outcome: 'failed', failedStep: 'content_fetch' });

    // Then
    expect(heard).toEqual([{ outcome: 'failed', failedStep: 'content_fetch' }]);
  });

  it('As a visitor, my app frame clears the screen for its password prompt and later fails, and I hear the clear first and then failed with its step', () => {
    // Given a watch that records what it hears, in order
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers: createManualTimers() });
    const heard = recordInOrder(load);

    // When the sandbox clears the screen for its prompt, then fails
    frame.postStatus({ done: true });
    frame.postStatus({ done: true, outcome: 'failed', failedStep: 'archive_password' });

    // Then
    expect(heard).toEqual(['cleared', { outcome: 'failed', failedStep: 'archive_password' }]);
  });

  it('As a visitor, my app frame reports twice and I hear the screen cleared once and both outcomes', () => {
    // Given a watch that records what it hears, in order
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers: createManualTimers() });
    const heard = recordInOrder(load);

    // When
    frame.postStatus({ done: true, outcome: 'loaded' });
    frame.postStatus({ done: true, outcome: 'failed', failedStep: 'content_fetch' });

    // Then
    expect(heard).toEqual([
      'cleared',
      { outcome: 'loaded', failedStep: undefined },
      { outcome: 'failed', failedStep: 'content_fetch' },
    ]);
  });

  it('As a visitor, I start following the screen after my app frame cleared it and hear the clear at once, once', () => {
    // Given an app frame that cleared the screen before anyone followed it
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers: createManualTimers() });
    frame.postStatus({ done: true });
    const heard: string[] = [];

    // When a follower subscribes and the frame reports again
    load.subscribeCleared(() => heard.push('cleared'));
    frame.postStatus({ done: true, outcome: 'loaded' });

    // Then
    expect(heard).toEqual(['cleared']);
  });

  it('As a visitor, I start following the outcomes when my app frame clears the screen and hear the outcome that cleared it once', () => {
    // Given a follower of the clear that then follows the outcomes
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers: createManualTimers() });
    const heard: SandboxLoadReport[] = [];
    load.subscribeCleared(() => {
      load.subscribeOutcomes(report => heard.push(report));
    });

    // When
    frame.postStatus({ done: true, outcome: 'loaded' });

    // Then
    expect(heard).toEqual([{ outcome: 'loaded', failedStep: undefined }]);
  });

  it('As a visitor whose app frame fails and then loads on my retry, I hear both outcomes in order', () => {
    // Given a follower of the app frame's outcomes
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers: createManualTimers() });
    const heard: SandboxLoadReport[] = [];
    load.subscribeOutcomes(report => heard.push(report));

    // When the first attempt fails and the retry loads
    frame.postStatus({ done: true, outcome: 'failed', failedStep: 'archive_fetch' });
    frame.postStatus({ done: true, outcome: 'loaded' });

    // Then
    expect(heard).toEqual([
      { outcome: 'failed', failedStep: 'archive_fetch' },
      { outcome: 'loaded', failedStep: undefined },
    ]);
  });

  it('As a visitor, I start following my app frame after it reported twice and hear its latest outcome at once, then the next one', () => {
    // Given an app frame that failed and then loaded before anyone followed it
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers: createManualTimers() });
    frame.postStatus({ done: true, outcome: 'failed', failedStep: 'archive_fetch' });
    frame.postStatus({ done: true, outcome: 'loaded' });
    const heard: SandboxLoadReport[] = [];

    // When a follower subscribes and the frame reports again
    load.subscribeOutcomes(report => heard.push(report));
    frame.postStatus({ done: true, outcome: 'failed', failedStep: 'content_fetch' });

    // Then it heard the latest outcome first and then the new one
    expect(heard).toEqual([
      { outcome: 'loaded', failedStep: undefined },
      { outcome: 'failed', failedStep: 'content_fetch' },
    ]);
  });

  it('As a visitor whose watch on the app frame stopped, I hear no outcome the frame reports after', () => {
    // Given a follower of a watch that was stopped
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers: createManualTimers() });
    const heard: SandboxLoadReport[] = [];
    load.subscribeOutcomes(report => heard.push(report));
    load.dispose();

    // When the app frame reports
    frame.postStatus({ done: true, outcome: 'loaded' });

    // Then nothing was heard and nothing is left listening
    expect(heard).toEqual([]);
    expect(frame.countListening()).toBe(0);
  });

  it('As a visitor who stopped following my app frame, I hear none of its later outcomes, and stopping twice is safe', () => {
    // Given a follower that stopped
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers: createManualTimers() });
    const heard: SandboxLoadReport[] = [];
    const stopFollowing = load.subscribeOutcomes(report => heard.push(report));
    stopFollowing();

    // When it stops again and the app frame loads
    stopFollowing();
    frame.postStatus({ done: true, outcome: 'loaded' });

    // Then it heard nothing
    expect(heard).toEqual([]);
  });

  it('As an operator, I watch a follower of the app frame throw and see it reported while the other followers still hear the outcome', () => {
    // Given a follower that throws and one that records
    const { captures } = bindReports();
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers: createManualTimers() });
    load.subscribeOutcomes(() => {
      throw new Error('a follower broke');
    });
    const heard: SandboxLoadReport[] = [];
    load.subscribeOutcomes(report => heard.push(report));

    // When the app frame loads
    frame.postStatus({ done: true, outcome: 'loaded' });

    // Then the throw was reported as a listener's and the other follower heard the outcome
    expect(captures.exception.mock.calls.map(([, context]) => context.step)).toEqual(['listener']);
    expect(heard).toEqual([{ outcome: 'loaded', failedStep: undefined }]);
  });

  it('As an operator, I watch a follower of the screen clear throw and see it reported as a clear listener while the other followers still hear the clear', () => {
    // Given a clear follower that throws and one that records
    const { captures } = bindReports();
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers: createManualTimers() });
    load.subscribeCleared(() => {
      throw new Error('a follower broke');
    });
    const heard: string[] = [];
    load.subscribeCleared(() => heard.push('cleared'));

    // When the app frame clears the screen
    frame.postStatus({ done: true });

    // Then the throw was reported under the clear's listeners and the other follower heard the clear
    expect(captures.exception.mock.calls.map(([, context]) => [context.step, context.tags?.['owner']])).toEqual([
      ['listener', 'sandbox_load.cleared'],
    ]);
    expect(heard).toEqual(['cleared']);
  });

  it('As an operator, I see a sandbox channel that throws as the watch starts reported as a defect while the watch returns', () => {
    // Given a channel that cannot be listened to
    const { captures, counted } = bindReports();
    const channel: Pick<SandboxChannel, 'on'> = {
      on() {
        throw new Error('the channel is closed');
      },
    };

    // When
    watchSandboxLoad(channel, { timers: createManualTimers() });

    // Then
    expect(captures.exception.mock.calls.map(([, context]) => context.step)).toEqual(['transition']);
    expect(counted('sandbox_load.transition')).toEqual([expect.objectContaining({ outcome: 'error' })]);
  });

  it('As a visitor whose watch on the app frame stopped twice, a deadline asked before the stop never calls the frame silent and nothing is left listening', async () => {
    // Given a deadline asked, then a watch stopped twice
    const timers = createManualTimers();
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers });
    const silences: SandboxSilentError[] = [];
    load.expectHeardWithin(error => silences.push(error));
    load.dispose();
    load.dispose();

    // When the deadline passes
    await timers.advance(30_000);

    // Then
    expect(silences).toEqual([]);
    expect(frame.countListening()).toBe(0);
  });

  it('As a visitor whose app frame never speaks, I wait out the deadline and hear the frame silent once', async () => {
    // Given
    const timers = createManualTimers();
    const load = watchSandboxLoad(createSandboxFrame().channel, { timers });
    const silences: SandboxSilentError[] = [];
    load.expectHeardWithin(error => silences.push(error));

    // When
    await timers.advance(30_000);

    // Then
    expect(silences).toEqual([expect.any(SandboxSilentError)]);
  });

  it('As a visitor whose load asks to wait again, I hear the frame silent only for the later ask, and the earlier ask stops nothing', async () => {
    // Given a deadline asked twice, and the stop of the first
    const timers = createManualTimers();
    const load = watchSandboxLoad(createSandboxFrame().channel, { timers });
    const earlier: SandboxSilentError[] = [];
    const later: SandboxSilentError[] = [];
    const stopEarlier = load.expectHeardWithin(error => earlier.push(error));
    load.expectHeardWithin(error => later.push(error));

    // When the earlier ask is stopped and the later deadline passes
    stopEarlier();
    await timers.advance(30_000);

    // Then
    expect(earlier).toEqual([]);
    expect(later).toEqual([expect.any(SandboxSilentError)]);
  });

  it('As an operator, I see a silence handler that throws reported as a defect while the watch goes on', async () => {
    // Given a deadline whose handler throws
    const { captures } = bindReports();
    const timers = createManualTimers();
    const load = watchSandboxLoad(createSandboxFrame().channel, { timers });
    load.expectHeardWithin(() => {
      throw new Error('the handler broke');
    });

    // When the deadline passes
    await timers.advance(30_000);

    // Then
    expect(captures.exception.mock.calls.map(([, context]) => context.step)).toEqual(['transition']);
  });

  it('As a visitor whose app frame speaks during the wait, I never hear the frame silent', async () => {
    // Given a wait that has run to just short of its deadline
    const timers = createManualTimers();
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers });
    const silences: SandboxSilentError[] = [];
    load.expectHeardWithin(error => silences.push(error));
    await timers.advance(29_999);

    // When the frame speaks and the deadline passes
    frame.postStatus({ message: 'Starting' });
    await timers.advance(1);

    // Then
    expect(silences).toEqual([]);
  });

  it('As a visitor whose app frame spoke before the deadline started, I never hear the frame silent', async () => {
    // Given the sandbox speaking before the deadline starts
    const timers = createManualTimers();
    const frame = createSandboxFrame();
    const load = watchSandboxLoad(frame.channel, { timers });
    frame.postStatus({ message: 'Starting' });
    const silences: SandboxSilentError[] = [];

    // When the deadline is asked and its time passes
    load.expectHeardWithin(error => silences.push(error));
    await timers.advance(30_000);

    // Then
    expect(silences).toEqual([]);
  });

  it('As a visitor whose load stopped waiting for the app frame, I never hear the frame silent', async () => {
    // Given a deadline that was stopped
    const timers = createManualTimers();
    const load = watchSandboxLoad(createSandboxFrame().channel, { timers });
    const silences: SandboxSilentError[] = [];
    const stopDeadline = load.expectHeardWithin(error => silences.push(error));

    // When
    stopDeadline();
    await timers.advance(30_000);

    // Then
    expect(silences).toEqual([]);
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

/** Records the clear and each outcome in the order they are heard. */
function recordInOrder(load: SandboxLoad): unknown[] {
  const heard: unknown[] = [];
  load.subscribeCleared(() => heard.push('cleared'));
  load.subscribeOutcomes(report => heard.push(report));
  return heard;
}
