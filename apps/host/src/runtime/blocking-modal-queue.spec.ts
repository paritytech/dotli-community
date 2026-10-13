// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createBlockingModalCoordinator, type BlockingModalCounts } from './blocking-modal-queue.js';

/** The page's side of the counts: the latest report, and a hook run on each. */
function countsSink(onReport: (counts: BlockingModalCounts) => void = () => undefined): {
  report: (counts: BlockingModalCounts) => void;
  latest: () => BlockingModalCounts;
} {
  let latest: BlockingModalCounts = { waiting: 0, active: false };
  return {
    report: counts => {
      latest = counts;
      onReport(counts);
    },
    latest: () => latest,
  };
}

describe('blocking modal queue', () => {
  it('As a dotli integrator, I run a prompt that throws and the next prompt shows, with the failed one run once', async () => {
    // Given
    const coordinator = createBlockingModalCoordinator();
    const firstScope = coordinator.createScope();
    const secondScope = coordinator.createScope();
    const throwing = vi.fn(() => {
      throw new Error('render failed');
    });

    // When
    const failed = firstScope.enqueue(throwing);
    const completed = secondScope.enqueue(() => 'next');

    // Then
    await expect(failed).rejects.toThrow('render failed');
    await expect(completed).resolves.toBe('next');
    expect(throwing).toHaveBeenCalledTimes(1);
    firstScope.dispose();
    secondScope.dispose();
  });

  it('As a dotli integrator, I run a prompt that disposes its own scope and then rejects, and it settles as aborted', async () => {
    // Given
    const scope = createBlockingModalCoordinator().createScope();
    const queued = scope.enqueue(() => {
      scope.dispose();
      return Promise.reject(new Error('late task failure'));
    });

    // Then
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
  });

  it('As a dotli integrator, I dispose the host of a prompt that ignores its signal and the next prompt shows', async () => {
    // Given
    const coordinator = createBlockingModalCoordinator();
    const stuckScope = coordinator.createScope();
    const nextScope = coordinator.createScope();
    const stuck = stuckScope.enqueue(() => new Promise<never>(() => {}));
    const next = nextScope.enqueue(() => 'shown');

    // When
    stuckScope.dispose();

    // Then
    await expect(stuck).rejects.toMatchObject({ name: 'AbortError' });
    await expect(next).resolves.toBe('shown');
    nextScope.dispose();
  });

  it('As a dotli integrator, I dispose a host as its prompt comes up and the prompt never runs', async () => {
    // Given: a listener of the counts that leaves the product as soon as a prompt shows
    const bar = countsSink(counts => {
      if (counts.active) {
        scope.dispose();
      }
    });
    const scope = createBlockingModalCoordinator({ report: bar.report }).createScope();
    const task = vi.fn(() => 'shown');

    // When
    const shown = scope.enqueue(task);

    // Then
    await expect(shown).rejects.toMatchObject({ name: 'AbortError' });
    expect(task).not.toHaveBeenCalled();
    expect(bar.latest().active).toBe(false);
  });

  it('As a dotli integrator, I dispose a host and its queued and later prompts are rejected', async () => {
    // Given
    const coordinator = createBlockingModalCoordinator();
    const activeScope = coordinator.createScope();
    const disposedScope = coordinator.createScope();
    const { promise: held, resolve: finishActive }: PromiseWithResolvers<void> = Promise.withResolvers();
    const active = activeScope.enqueue(() => held);
    const queued = disposedScope.enqueue(() => 'queued');

    // When
    disposedScope.dispose();

    // Then
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await expect(disposedScope.enqueue(() => 'late')).rejects.toMatchObject({
      name: 'AbortError',
    });
    finishActive();
    await active;
    activeScope.dispose();
  });
});

describe('blocking modal queue, waiting count', () => {
  it('As a user, I queue a second prompt and the bar counts it waiting behind the one on screen', async () => {
    // Given
    const bar = countsSink();
    const scope = createBlockingModalCoordinator({ report: bar.report }).createScope();
    let finishFirst: () => void = () => {};
    const first = scope.enqueue(
      () =>
        new Promise<void>(resolve => {
          finishFirst = resolve;
        }),
    );
    const second = scope.enqueue(() => new Promise<void>(() => {}));

    // Then
    expect(bar.latest().active).toBe(true);
    expect(bar.latest().waiting).toBe(1);

    // When
    finishFirst();
    await first;

    // Then
    expect(bar.latest().waiting).toBe(0);
    scope.dispose();
    await second.catch(() => {});
  });

  it('As a user, I answer one prompt with another queued and the bar stays busy with no idle gap between them', async () => {
    // Given
    const seen: boolean[] = [];
    const bar = countsSink(counts => {
      seen.push(counts.active);
    });
    const scope = createBlockingModalCoordinator({ report: bar.report }).createScope();
    let finishFirst: () => void = () => {};
    const first = scope.enqueue(
      () =>
        new Promise<void>(resolve => {
          finishFirst = resolve;
        }),
    );
    const second = scope.enqueue(() => 'second');

    // When
    finishFirst();
    await first;
    await second;

    // Then
    expect(bar.latest().active).toBe(false);
    expect(seen.filter((active, i) => i === 0 || active !== seen[i - 1])).toEqual([true, false]);
    scope.dispose();
  });

  it('As a user, I leave a product mid-prompt and the bar is idle as soon as it is disposed', async () => {
    // Given
    const bar = countsSink();
    const scope = createBlockingModalCoordinator({ report: bar.report }).createScope();
    const shown = scope.enqueue(() => new Promise<void>(() => {}));
    expect(bar.latest().active).toBe(true);

    // When
    scope.dispose();

    // Then
    expect(bar.latest().active).toBe(false);
    await shown.catch(() => {});
  });

  it('As a user, I leave a product and its waiting prompts no longer count', async () => {
    // Given
    const bar = countsSink();
    const coordinator = createBlockingModalCoordinator({ report: bar.report });
    const other = coordinator.createScope();
    const leaving = coordinator.createScope();
    const active = other.enqueue(() => new Promise<void>(() => {}));
    const waiting = leaving.enqueue(() => new Promise<void>(() => {}));
    expect(bar.latest().waiting).toBe(1);

    // When
    leaving.dispose();
    await waiting.catch(() => {});

    // Then
    expect(bar.latest().waiting).toBe(0);
    other.dispose();
    await active.catch(() => {});
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
    // Given
    const bar = countsSink();
    const scope = createBlockingModalCoordinator({ report: bar.report }).createScope();
    const task = vi.fn(body);

    // When
    const failed = scope.enqueue(task);
    await expect(failed).rejects.toThrow('render failed');

    // Then
    expect(task).toHaveBeenCalledTimes(1);
    expect(bar.latest().active).toBe(false);
    expect(bar.latest().waiting).toBe(0);
    scope.dispose();
  });

  it('As a user, I leave a product whose prompt is shown and only the next prompt takes its place, the one after it still waiting', async () => {
    // Given a prompt on screen and two from another product waiting behind it
    const bar = countsSink();
    const coordinator = createBlockingModalCoordinator({ report: bar.report });
    const leaving = coordinator.createScope();
    const staying = coordinator.createScope();
    const shown = leaving.enqueue(() => new Promise<void>(() => {}));
    const second = vi.fn(() => new Promise<void>(() => {}));
    const third = vi.fn(() => 'third');
    const secondShown = staying.enqueue(second);
    const thirdShown = staying.enqueue(third);
    expect(bar.latest().waiting).toBe(2);

    // When the product whose prompt is shown is left
    leaving.dispose();
    await expect(shown).rejects.toMatchObject({ name: 'AbortError' });

    // Then its slot goes to the next prompt alone
    expect(second).toHaveBeenCalledTimes(1);
    expect(third).not.toHaveBeenCalled();
    expect(bar.latest().active).toBe(true);
    expect(bar.latest().waiting).toBe(1);
    staying.dispose();
    await Promise.allSettled([secondShown, thirdShown]);
  });
});
