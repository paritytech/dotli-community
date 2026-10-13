// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindCaptureSink } from '@dotli/metrics';
import { FakePage } from '@dotli/shared/testing';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  bindToastPage,
  clearToasts,
  dismissAllToasts,
  dismissToast,
  pushToast as pushToastTo,
  removeToast,
  resetToastsForTests,
  setToastsExpanded,
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

/** A page that counts the visibility listeners still attached, as each is removed through its abort signal. */
class ListenerCountingPage extends FakePage {
  visibilityListeners = 0;

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    super.addEventListener(type, listener, options);
    if (type !== 'visibilitychange') {
      return;
    }
    this.visibilityListeners += 1;
    const signal = typeof options === 'object' ? options.signal : undefined;
    signal?.addEventListener('abort', () => {
      this.visibilityListeners -= 1;
    });
  }
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
  bindToastPage(page);
});

afterEach(() => {
  resetToastsForTests();
  vi.useRealTimers();
});

describe('toast store', () => {
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

  it('As a dotli page reset between stories, I bind my page again and it listens for visibility once', () => {
    // Given a page bound, reset, and bound again
    const counted = new ListenerCountingPage();
    bindToastPage(counted);
    resetToastsForTests();

    // When
    bindToastPage(counted);
    bindToastPage(counted);

    // Then
    expect(counted.visibilityListeners).toBe(1);
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
