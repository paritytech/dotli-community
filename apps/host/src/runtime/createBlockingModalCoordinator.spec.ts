// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createDeferred } from '@dotli/shared';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createBlockingModalCoordinator, type BlockingModalCounts } from './createBlockingModalCoordinator.js';

type CreateCountsSinkParams = {
  /** Run on each report, nothing by default. */
  onReport?: (counts: BlockingModalCounts) => void;
};

/** The page's side of the counts: the latest report, and a hook run on each. */
function createCountsSink({ onReport = () => undefined }: CreateCountsSinkParams = {}) {
  let latest: BlockingModalCounts = { waiting: 0, active: false };

  function recordReport(counts: BlockingModalCounts): void {
    latest = counts;
    onReport(counts);
  }

  return {
    /** Takes a report of the counts. */
    report: recordReport,
    /** The counts last reported. */
    latest: (): BlockingModalCounts => latest,
  };
}

/** A prompt that holds the slot past its answer with a step the test settles, and a second prompt queued behind it. */
function queueHeldPrompt() {
  const bar = createCountsSink();
  const scope = createBlockingModalCoordinator({ report: bar.report }).createScope();
  const step = createDeferred<undefined>();
  const next = vi.fn(() => 'next');
  const first = scope.enqueue((_signal, hold) => {
    hold(step.promise);
    return 'answered';
  });
  const second = scope.enqueue(next);
  onTestFinished(async () => {
    scope.dispose();
    await Promise.allSettled([first, second]);
  });
  return { bar, step, next, first, second };
}

describe('blocking modal queue', () => {
  it('As a dotli integrator, I run a prompt that throws and the next prompt shows, with the failed one run once', async () => {
    // Given two hosts, the first with a prompt that throws
    const coordinator = createBlockingModalCoordinator();
    const firstScope = coordinator.createScope();
    const secondScope = coordinator.createScope();
    onTestFinished(() => {
      firstScope.dispose();
      secondScope.dispose();
    });
    const throwing = vi.fn(() => {
      throw new Error('render failed');
    });

    // When both prompts are queued
    const failed = firstScope.enqueue(throwing);
    const completed = secondScope.enqueue(() => 'next');

    // Then the first fails once and the next one shows
    await expect(failed).rejects.toThrow('render failed');
    await expect(completed).resolves.toBe('next');
    expect(throwing).toHaveBeenCalledTimes(1);
  });

  it('As a dotli integrator, I run a prompt that disposes its own scope and then rejects, and it settles as aborted', async () => {
    // Given a host
    const scope = createBlockingModalCoordinator().createScope();

    // When its prompt disposes the host and then rejects
    const queued = scope.enqueue(() => {
      scope.dispose();
      return Promise.reject(new Error('late task failure'));
    });
    const settled = await queued.catch((error: unknown) => error);

    // Then it settles as aborted
    expect(settled).toMatchObject({ name: 'AbortError' });
  });

  it('As a dotli integrator, I dispose the host of a prompt that ignores its signal and the next prompt shows', async () => {
    // Given a prompt that never settles and one queued behind it from another host
    const coordinator = createBlockingModalCoordinator();
    const stuckScope = coordinator.createScope();
    const nextScope = coordinator.createScope();
    onTestFinished(() => {
      nextScope.dispose();
    });
    const stuck = stuckScope.enqueue(() => new Promise<never>(() => {}));
    const next = nextScope.enqueue(() => 'shown');

    // When the stuck prompt's host is disposed
    stuckScope.dispose();

    // Then the stuck prompt is aborted and the next one shows
    await expect(stuck).rejects.toMatchObject({ name: 'AbortError' });
    await expect(next).resolves.toBe('shown');
  });

  it('As a dotli integrator, I dispose a host as its prompt comes up and the prompt never runs', async () => {
    // Given a listener of the counts that leaves the product as soon as a prompt shows
    const bar = createCountsSink({
      onReport(counts) {
        if (counts.active) {
          scope.dispose();
        }
      },
    });
    const scope = createBlockingModalCoordinator({ report: bar.report }).createScope();
    const task = vi.fn(() => 'shown');

    // When a prompt is queued
    const shown = scope.enqueue(task);

    // Then it is aborted before it runs and the bar is idle
    await expect(shown).rejects.toMatchObject({ name: 'AbortError' });
    expect(task).not.toHaveBeenCalled();
    expect(bar.latest().active).toBe(false);
  });

  it('As a dotli integrator, I dispose a host and its queued and later prompts are rejected', async () => {
    // Given a host whose prompt waits behind another host's
    const coordinator = createBlockingModalCoordinator();
    const activeScope = coordinator.createScope();
    const disposedScope = coordinator.createScope();
    const held = createDeferred<undefined>();
    const active = activeScope.enqueue(() => held.promise);
    onTestFinished(async () => {
      held.resolve(undefined);
      await active;
      activeScope.dispose();
    });
    const queued = disposedScope.enqueue(() => 'queued');

    // When the waiting host is disposed and asked for another prompt
    disposedScope.dispose();
    const late = disposedScope.enqueue(() => 'late');

    // Then both its prompts are aborted
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await expect(late).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('blocking modal queue, waiting count', () => {
  it('As a dotli integrator, I hold the slot past my answer and the next prompt waits while what I hold is pending', async () => {
    // Given a prompt that holds the slot past its answer, and a second one behind it
    const { bar, next, first } = queueHeldPrompt();

    // When the first prompt answers
    const answer = await first;

    // Then the answer comes back while the next prompt still waits
    expect(answer).toBe('answered');
    expect(next).not.toHaveBeenCalled();
    expect(bar.latest()).toEqual({ waiting: 1, active: true });
  });

  it('As a dotli integrator, I hold the slot past my answer and the next prompt shows once what I hold settles', async () => {
    // Given a prompt that answered and still holds the slot
    const { bar, step, first, second } = queueHeldPrompt();
    await first;

    // When what it holds fails
    step.reject(new Error('the step failed'));

    // Then the next prompt shows and the bar goes idle once it answers
    await expect(second).resolves.toBe('next');
    expect(bar.latest()).toEqual({ waiting: 0, active: false });
  });

  it('As a dotli integrator, I dispose a host whose prompt holds the slot and the next prompt shows', async () => {
    // Given a prompt that answered and holds the slot forever, and one from another host behind it
    const coordinator = createBlockingModalCoordinator();
    const holding = coordinator.createScope();
    const other = coordinator.createScope();
    onTestFinished(() => {
      other.dispose();
    });
    const answered = holding.enqueue((_signal, hold) => {
      hold(new Promise(() => {}));
      return 'answered';
    });
    const next = other.enqueue(() => 'next');
    await answered;

    // When the holding host is disposed
    holding.dispose();

    // Then the holding prompt had answered and the next one shows
    await expect(answered).resolves.toBe('answered');
    await expect(next).resolves.toBe('next');
  });

  it('As a user, I answer one prompt with another queued and the bar stays busy with no idle gap between them', async () => {
    // Given a prompt on screen and a second one behind it, with every report seen
    const seen: boolean[] = [];
    const bar = createCountsSink({
      onReport(counts) {
        seen.push(counts.active);
      },
    });
    const scope = createBlockingModalCoordinator({ report: bar.report }).createScope();
    onTestFinished(() => {
      scope.dispose();
    });
    const shown = createDeferred<undefined>();
    const first = scope.enqueue(() => shown.promise);
    const second = scope.enqueue(() => 'second');

    // When the first is answered and the second shows and answers
    shown.resolve(undefined);
    await first;
    await second;

    // Then the bar went busy once and idle once
    expect(bar.latest().active).toBe(false);
    expect(seen.filter((active, i) => i === 0 || active !== seen[i - 1])).toEqual([true, false]);
  });

  it('As a user, I leave a product mid-prompt and the bar is idle as soon as it is disposed', () => {
    // Given a prompt on screen
    const bar = createCountsSink();
    const scope = createBlockingModalCoordinator({ report: bar.report }).createScope();
    const shown = scope.enqueue(() => new Promise<void>(() => {}));
    onTestFinished(async () => {
      await shown.catch(() => {});
    });
    const activeBefore = bar.latest().active;

    // When the product is left
    scope.dispose();

    // Then the bar went from busy to idle
    expect([activeBefore, bar.latest().active]).toEqual([true, false]);
  });

  it('As a user, I leave a product and its waiting prompts no longer count', async () => {
    // Given another product's prompt on screen and this product's prompt waiting
    const bar = createCountsSink();
    const coordinator = createBlockingModalCoordinator({ report: bar.report });
    const other = coordinator.createScope();
    const leaving = coordinator.createScope();
    const active = other.enqueue(() => new Promise<void>(() => {}));
    onTestFinished(async () => {
      other.dispose();
      await active.catch(() => {});
    });
    const waiting = leaving.enqueue(() => new Promise<void>(() => {}));
    const waitingBefore = bar.latest().waiting;

    // When the product is left
    leaving.dispose();
    await waiting.catch(() => {});

    // Then its prompt no longer counts
    expect([waitingBefore, bar.latest().waiting]).toEqual([1, 0]);
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error('render failed');
      },
    ],
    ['rejects later', () => Promise.reject(new Error('render failed'))],
  ])('As a user, I see a prompt that %s and the bar goes idle', async (_kind, body) => {
    // Given a prompt that fails
    const bar = createCountsSink();
    const scope = createBlockingModalCoordinator({ report: bar.report }).createScope();
    onTestFinished(() => {
      scope.dispose();
    });
    const task = vi.fn(body);

    // When it is queued
    const failed = scope.enqueue(task);

    // Then it fails once and the bar goes idle
    await expect(failed).rejects.toThrow('render failed');
    expect(task).toHaveBeenCalledTimes(1);
    expect(bar.latest()).toEqual({ active: false, waiting: 0 });
  });

  it('As a user, I leave a product whose prompt is shown and only the next prompt takes its place, the one after it still waiting', async () => {
    // Given a prompt on screen and two from another product waiting behind it
    const bar = createCountsSink();
    const coordinator = createBlockingModalCoordinator({ report: bar.report });
    const leaving = coordinator.createScope();
    const staying = coordinator.createScope();
    const shown = leaving.enqueue(() => new Promise<void>(() => {}));
    const second = vi.fn(() => new Promise<void>(() => {}));
    const third = vi.fn(() => 'third');
    const secondShown = staying.enqueue(second);
    const thirdShown = staying.enqueue(third);
    onTestFinished(async () => {
      staying.dispose();
      await Promise.allSettled([secondShown, thirdShown]);
    });
    const waitingBefore = bar.latest().waiting;

    // When the product whose prompt is shown is left
    leaving.dispose();

    // Then its slot goes to the next prompt alone
    await expect(shown).rejects.toMatchObject({ name: 'AbortError' });
    expect(waitingBefore).toBe(2);
    expect(second).toHaveBeenCalledTimes(1);
    expect(third).not.toHaveBeenCalled();
    expect(bar.latest()).toEqual({ active: true, waiting: 1 });
  });
});
