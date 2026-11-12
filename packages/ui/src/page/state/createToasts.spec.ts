// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';
import {
  createFakePage,
  createManualTimers,
  recordLog,
  resetAllStoresForTests,
  type FakePage,
  type ManualTimers,
} from '@dotli/shared/testing';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createToasts, type ToastInput } from './createToasts.js';

let page: FakePage;
let timers: ManualTimers;
let toasts: ReturnType<typeof createToasts>;

function buildInput(overrides: Partial<ToastInput> = {}): ToastInput {
  return {
    text: 'Body',
    label: 'Title',
    icon: () => null,
    dismissMs: 1000,
    ...overrides,
  };
}

function readLeaving(): boolean[] {
  return toasts.store.get().items.map(toast => toast.leaving);
}

beforeEach(() => {
  page = createFakePage();
  timers = createManualTimers();
  toasts = createToasts({ page: page.document, timers });
});

afterEach(() => {
  resetAllStoresForTests();
});

describe('toast store', () => {
  beforeEach(() => {
    toasts.show();
  });

  it('As a dotli user, I get a toast without a tone and it reads as info, and a toast given one keeps it', () => {
    // When
    toasts.push(buildInput());
    toasts.push(buildInput({ tone: 'warn' }));

    // Then
    expect(toasts.store.get().items.map(toast => toast.tone)).toEqual(['info', 'warn']);
  });

  it('As a dotli user, I wait out the duration of a toast and it leaves and calls onDismiss once', async () => {
    // Given
    const onDismiss = vi.fn();
    toasts.push(buildInput({ onDismiss }));

    // When
    await timers.advance(999);

    // Then
    expect(readLeaving()).toEqual([false]);

    // When
    await timers.advance(1);

    // Then
    expect(readLeaving()).toEqual([true]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, I get a persistent toast and it stays until I close it', async () => {
    // Given
    const id = toasts.push(buildInput({ dismissMs: 0 }));

    // When
    await timers.advance(60_000);

    // Then
    expect(readLeaving()).toEqual([false]);

    // When
    toasts.dismiss(id);

    // Then
    expect(readLeaving()).toEqual([true]);
  });

  it('As a dotli user, I get a persistent toast given a dismiss time and it leaves once that time is out', async () => {
    // Given
    const id = toasts.push(buildInput({ dismissMs: 0 }));

    // When
    toasts.setDismissMs(id, 1000);
    await timers.advance(1000);

    // Then
    expect(readLeaving()).toEqual([true]);
  });

  it('As a dotli user, I close a persistent toast and a dismiss time given after it leaves it leaving', async () => {
    // Given
    const onDismiss = vi.fn();
    const id = toasts.push(buildInput({ dismissMs: 0, onDismiss }));
    toasts.dismiss(id);

    // When
    toasts.setDismissMs(id, 1000);
    await timers.advance(1000);

    // Then
    expect(readLeaving()).toEqual([true]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, I hide the tab and the countdown pauses, and resumes from what was left once I come back', async () => {
    // Given
    toasts.push(buildInput());
    await timers.advance(600);

    // When
    page.setVisibility('hidden');
    await timers.advance(5000);

    // Then
    expect(readLeaving()).toEqual([false]);

    // When
    page.setVisibility('visible');
    await timers.advance(399);

    // Then
    expect(readLeaving()).toEqual([false]);

    // When
    await timers.advance(1);

    // Then
    expect(readLeaving()).toEqual([true]);
  });

  it('As a dotli user, I come back to the tab and a toast shown while it was hidden gets its full time', async () => {
    // Given
    page.setVisibility('hidden');
    toasts.push(buildInput());
    await timers.advance(10_000);

    // When
    page.setVisibility('visible');
    await timers.advance(999);

    // Then
    expect(readLeaving()).toEqual([false]);

    // When
    await timers.advance(1);

    // Then
    expect(readLeaving()).toEqual([true]);
  });

  it('As a dotli user, I hide the tab at the very end of a countdown, and the toast leaves once I come back', async () => {
    // Given
    toasts.push(buildInput({ dismissMs: 1000 }));
    timers.freeze(1000);

    // When
    page.setVisibility('hidden');
    page.setVisibility('visible');
    await timers.advance(0);

    // Then
    expect(readLeaving()).toEqual([true]);
  });

  it('As a dotli user, I expand the stack and every countdown pauses until it collapses', async () => {
    // Given
    toasts.push(buildInput());
    toasts.push(buildInput());

    // When
    toasts.setExpanded(true);
    await timers.advance(5000);

    // Then
    expect(toasts.store.get().expanded).toBe(true);
    expect(readLeaving()).toEqual([false, false]);

    // When
    toasts.setExpanded(false);
    await timers.advance(1000);

    // Then
    expect(readLeaving()).toEqual([true, true]);
  });

  it('As a dotli user, I close toasts until one is left and the stack collapses and its countdown resumes', async () => {
    // Given
    const first = toasts.push(buildInput({ dismissMs: 0 }));
    toasts.push(buildInput());
    toasts.setExpanded(true);

    // When
    toasts.dismiss(first);
    toasts.remove(first);

    // Then
    expect(toasts.store.get().expanded).toBe(false);

    // When
    await timers.advance(1000);

    // Then
    expect(readLeaving()).toEqual([true]);
  });

  it('As a dotli user, I dismiss all and every toast leaves and each onDismiss is called once', async () => {
    // Given
    const onFirstDismiss = vi.fn();
    const onSecondDismiss = vi.fn();
    toasts.push(buildInput({ onDismiss: onFirstDismiss }));
    toasts.push(buildInput({ onDismiss: onSecondDismiss, dismissMs: 0 }));

    // When
    toasts.dismissAll();
    await timers.advance(5000);

    // Then
    expect(readLeaving()).toEqual([true, true]);
    expect(onFirstDismiss).toHaveBeenCalledTimes(1);
    expect(onSecondDismiss).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, I close a toast whose onDismiss shows another, and the new one counts down', async () => {
    // Given
    const id = toasts.push(
      buildInput({
        onDismiss: () => {
          toasts.push(buildInput({ dismissMs: 1000 }));
        },
      }),
    );

    // When
    toasts.dismiss(id);

    // Then
    expect(readLeaving()).toEqual([true, false]);

    // When
    await timers.advance(1000);

    // Then
    expect(readLeaving()).toEqual([true, true]);
  });

  it('As a dotli user, I close a toast whose onDismiss throws and it still leaves, and the error is reported, logged and counted', () => {
    // Given
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const logged = recordLog({ onFinished: onTestFinished, level: 'error' });
    const error = new TypeError('callback broke');
    const id = toasts.push(
      buildInput({
        onDismiss: () => {
          throw error;
        },
      }),
    );

    // When
    toasts.dismiss(id);

    // Then
    expect(readLeaving()).toEqual([true]);
    expect(captured).toMatchObject([{ step: 'listener', error, tags: { owner: 'toast.dismiss' } }]);
    expect(logged.map(line => line.args)).toEqual([['[dot.li] A toast.dismiss listener threw', error]]);
    expect(sentry.counted('listener.delivery')).toEqual([
      { outcome: 'error', reason: 'TypeError', owner: 'toast.dismiss' },
    ]);
  });

  it('As a dotli user, I dismiss all and a toast whose onDismiss throws does not stop the next toast from being told', () => {
    // Given two toasts, the first of which throws on dismiss
    const reports = recordReports({ onFinished: onTestFinished });
    const onSecondDismiss = vi.fn();
    toasts.push(
      buildInput({
        onDismiss: () => {
          throw new TypeError('callback broke');
        },
      }),
    );
    toasts.push(buildInput({ onDismiss: onSecondDismiss }));

    // When I dismiss all
    toasts.dismissAll();

    // Then both left, and the second was still told
    expect(readLeaving()).toEqual([true, true]);
    expect(onSecondDismiss).toHaveBeenCalledTimes(1);
    expect(reports.exceptions).toMatchObject([{ step: 'listener' }]);
  });

  it('As a dotli integrator, I remove a toast and clear the rest and the store empties without callbacks', async () => {
    // Given
    const onDismiss = vi.fn();
    const id = toasts.push(buildInput());
    toasts.push(buildInput({ onDismiss }));

    // When
    toasts.remove(id);
    toasts.clear();
    await timers.advance(5000);

    // Then
    expect(toasts.store.get()).toEqual({ items: [], expanded: false });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('As a dotli page reset between stories, I hide after the reset and the countdown still pauses, and the toast leaves once', async () => {
    // Given a reset, and a view shown after it
    resetAllStoresForTests();
    toasts.show();
    const onDismiss = vi.fn();
    toasts.push(buildInput({ onDismiss }));

    // When the page hides and shows again after the dismiss time
    page.setVisibility('hidden');
    await timers.advance(5000);
    page.setVisibility('visible');
    await timers.advance(999);
    const leavingBeforeTime = readLeaving();
    await timers.advance(1);

    // Then the toast leaves once, at the right time
    expect(leavingBeforeTime).toEqual([false]);
    expect(readLeaving()).toEqual([true]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('toast views', () => {
  it('As a visitor, I get a toast before any toast view exists and it waits until one shows it, then counts down', async () => {
    // Given
    toasts.push(buildInput({ dismissMs: 1000 }));

    // When
    await timers.advance(5000);

    // Then
    expect(readLeaving()).toEqual([false]);

    // When
    toasts.show();
    await timers.advance(1000);

    // Then
    expect(readLeaving()).toEqual([true]);
  });

  it('As a visitor, I lose the last toast view and the countdown pauses, and it runs while any view stays', async () => {
    // Given
    const hideFirst = toasts.show();
    const hideSecond = toasts.show();
    toasts.push(buildInput({ dismissMs: 1000 }));

    // When
    hideFirst();
    await timers.advance(400);
    hideSecond();
    await timers.advance(5000);

    // Then
    expect(readLeaving()).toEqual([false]);

    // When
    toasts.show();
    await timers.advance(600);

    // Then
    expect(readLeaving()).toEqual([true]);
  });

  it('As a page reset between stories, I unmount a view mounted before the reset and the next view still counts down', async () => {
    // Given: a view mounted, then the page reset under it
    const hideStale = toasts.show();
    resetAllStoresForTests();

    // When: the stale view unmounts, and the next story mounts its own
    hideStale();
    toasts.show();
    toasts.push(buildInput({ dismissMs: 1000 }));
    await timers.advance(1000);

    // Then
    expect(readLeaving()).toEqual([true]);
  });
});

describe('a toast stack that is disposed', () => {
  it('As a page that ends, I dispose the toasts and no countdown or page listener outlives them', async () => {
    // Given a stack with an open countdown and a bound page listener
    const listened = vi.spyOn(page.document, 'addEventListener');
    toasts.show();
    const onDismiss = vi.fn();
    toasts.push(buildInput({ dismissMs: 1000, onDismiss }));
    const options = listened.mock.calls.find(([type]) => type === 'visibilitychange')?.[2] as
      AddEventListenerOptions | undefined;

    // When
    toasts.dispose();
    toasts.dispose();
    await timers.advance(5000);

    // Then
    expect(options?.signal?.aborted).toBe(true);
    expect(toasts.store.get().items).toEqual([]);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
