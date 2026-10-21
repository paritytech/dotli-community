// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindCaptureSink } from '@dotli/metrics';
import { FakePage, resetAllStoresForTests } from '@dotli/shared/testing';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  bindToastPage,
  clearToasts,
  dismissAllToasts,
  dismissToast,
  pushToast as pushToastTo,
  removeToast,
  setToastsExpanded,
  showToasts,
  toastsStore,
  type ToastInput,
} from './toasts.js';

function input(overrides: Partial<ToastInput> = {}): ToastInput {
  return {
    text: 'Body',
    label: 'Title',
    icon: () => null,
    dismissMs: 1000,
    ...overrides,
  };
}

let page: FakePage;

function pushToast(toast: ToastInput): number {
  return pushToastTo(toast);
}

function setVisibility(state: 'visible' | 'hidden'): void {
  page.setVisibility(state);
}

function leaving(): boolean[] {
  return toastsStore.get().items.map(t => t.leaving);
}

beforeEach(() => {
  vi.useFakeTimers();
  page = new FakePage();
  bindToastPage(page.document);
});

afterEach(() => {
  resetAllStoresForTests();
  vi.useRealTimers();
});

describe('toast store', () => {
  beforeEach(() => {
    showToasts();
  });

  it('As a dotli user, a toast without a tone reads as info, and a toast given one keeps it', () => {
    // When
    pushToast(input());
    pushToast(input({ tone: 'warn' }));

    // Then
    expect(toastsStore.get().items.map(t => t.tone)).toEqual(['info', 'warn']);
  });

  it('As a dotli user, a toast leaves after its duration and calls onDismiss once', () => {
    // Given
    const onDismiss = vi.fn();
    pushToast(input({ onDismiss }));

    // When
    vi.advanceTimersByTime(999);

    // Then
    expect(leaving()).toEqual([false]);

    // When
    vi.advanceTimersByTime(1);

    // Then
    expect(leaving()).toEqual([true]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, a persistent toast stays until I close it', () => {
    // Given
    const id = pushToast(input({ dismissMs: 0 }));

    // When
    vi.advanceTimersByTime(60_000);

    // Then
    expect(leaving()).toEqual([false]);

    // When
    dismissToast(id);

    // Then
    expect(leaving()).toEqual([true]);
  });

  it('As a dotli user, the countdown pauses while the tab is hidden and resumes from what was left', () => {
    // Given
    pushToast(input());
    vi.advanceTimersByTime(600);

    // When
    setVisibility('hidden');
    vi.advanceTimersByTime(5000);

    // Then
    expect(leaving()).toEqual([false]);

    // When
    setVisibility('visible');
    vi.advanceTimersByTime(399);

    // Then
    expect(leaving()).toEqual([false]);

    // When
    vi.advanceTimersByTime(1);

    // Then
    expect(leaving()).toEqual([true]);
  });

  it('As a dotli user, a toast shown while the tab is hidden gets its full time once I come back', () => {
    // Given
    setVisibility('hidden');
    pushToast(input());
    vi.advanceTimersByTime(10_000);

    // When
    setVisibility('visible');
    vi.advanceTimersByTime(999);

    // Then
    expect(leaving()).toEqual([false]);

    // When
    vi.advanceTimersByTime(1);

    // Then
    expect(leaving()).toEqual([true]);
  });

  it('As a dotli user, an expanded stack pauses every countdown until it collapses', () => {
    // Given
    pushToast(input());
    pushToast(input());

    // When
    setToastsExpanded(true);
    vi.advanceTimersByTime(5000);

    // Then
    expect(toastsStore.get().expanded).toBe(true);
    expect(leaving()).toEqual([false, false]);

    // When
    setToastsExpanded(false);
    vi.advanceTimersByTime(1000);

    // Then
    expect(leaving()).toEqual([true, true]);
  });

  it('As a dotli user, the stack collapses and countdowns resume when only one toast is left', () => {
    // Given
    const first = pushToast(input({ dismissMs: 0 }));
    pushToast(input());
    setToastsExpanded(true);

    // When
    dismissToast(first);
    removeToast(first);

    // Then
    expect(toastsStore.get().expanded).toBe(false);

    // When
    vi.advanceTimersByTime(1000);

    // Then
    expect(leaving()).toEqual([true]);
  });

  it('As a dotli user, dismiss all marks every toast as leaving and calls each onDismiss once', () => {
    // Given
    const a = vi.fn();
    const b = vi.fn();
    pushToast(input({ onDismiss: a }));
    pushToast(input({ onDismiss: b, dismissMs: 0 }));

    // When
    dismissAllToasts();
    vi.advanceTimersByTime(5000);

    // Then
    expect(leaving()).toEqual([true, true]);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, a toast whose onDismiss throws still leaves, and the error is reported', () => {
    // Given
    const exception = vi.fn();
    onTestFinished(bindCaptureSink({ exception, expected: vi.fn() }));
    const error = new Error('callback broke');
    const id = pushToast(
      input({
        onDismiss: () => {
          throw error;
        },
      }),
    );

    // When
    dismissToast(id);

    // Then
    expect(leaving()).toEqual([true]);
    expect(exception).toHaveBeenCalledExactlyOnceWith(error, {
      flow: 'ui',
      step: 'toast_dismiss',
      tags: { kind: 'toast_on_dismiss_error' },
    });
  });

  it('As a dotli integrator, removing the last toast empties the store and clearToasts drops everything without callbacks', () => {
    // Given
    const onDismiss = vi.fn();
    const id = pushToast(input());
    pushToast(input({ onDismiss }));

    // When
    removeToast(id);
    clearToasts();
    vi.advanceTimersByTime(5000);

    // Then
    expect(toastsStore.get()).toEqual({ items: [], expanded: false });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('As a dotli page reset between stories, I bind my page again and its countdown resumes', () => {
    // Given a page bound, reset, and bound twice more
    const again = new FakePage();
    bindToastPage(again.document);
    resetAllStoresForTests();
    bindToastPage(again.document);
    bindToastPage(again.document);
    showToasts();
    const onDismiss = vi.fn();
    pushToast(input({ onDismiss }));

    // When the page hides and shows again after the dismiss time
    again.setVisibility('hidden');
    vi.advanceTimersByTime(5000);
    again.setVisibility('visible');
    vi.advanceTimersByTime(999);

    // Then the toast leaves once, at the right time
    expect(leaving()).toEqual([false]);
    vi.advanceTimersByTime(1);
    expect(leaving()).toEqual([true]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('As the toasts, clearing an empty stack notifies nobody', () => {
    // Given
    let notified = 0;
    const stop = toastsStore.subscribe(() => {
      notified += 1;
    });

    // When
    clearToasts();
    clearToasts();

    // Then
    expect(notified).toBe(0);
    stop();
  });
});

describe('toast views', () => {
  it('As a visitor, a toast pushed before any toast view exists waits until one shows it, then counts down', () => {
    // Given
    pushToast(input({ dismissMs: 1000 }));

    // When
    vi.advanceTimersByTime(5000);

    // Then
    expect(leaving()).toEqual([false]);

    // When
    showToasts();
    vi.advanceTimersByTime(1000);

    // Then
    expect(leaving()).toEqual([true]);
  });

  it('As a visitor, a toast shown in a mounted view dismisses itself after its time', () => {
    // Given
    showToasts();

    // When
    pushToast(input({ dismissMs: 1000 }));
    vi.advanceTimersByTime(999);

    // Then
    expect(leaving()).toEqual([false]);

    // When
    vi.advanceTimersByTime(1);

    // Then
    expect(leaving()).toEqual([true]);
  });

  it('As a visitor, the countdown pauses when the last view unmounts and runs while any view stays', () => {
    // Given
    const hideFirst = showToasts();
    const hideSecond = showToasts();
    pushToast(input({ dismissMs: 1000 }));

    // When
    hideFirst();
    vi.advanceTimersByTime(400);
    hideSecond();
    vi.advanceTimersByTime(5000);

    // Then
    expect(leaving()).toEqual([false]);

    // When
    showToasts();
    vi.advanceTimersByTime(600);

    // Then
    expect(leaving()).toEqual([true]);
  });

  it('As a page reset between stories, a view mounted before the reset unmounts after it and the next view still counts down', () => {
    // Given: a view mounted, then the page reset under it
    const hideStale = showToasts();
    resetAllStoresForTests();
    bindToastPage(page.document);

    // When: the stale view unmounts, and the next story mounts its own
    hideStale();
    showToasts();
    pushToast(input({ dismissMs: 1000 }));
    vi.advanceTimersByTime(1000);

    // Then
    expect(leaving()).toEqual([true]);
  });
});
