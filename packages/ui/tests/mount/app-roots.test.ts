// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../../metrics/src/sentry.js', () => sentry);

import { disposeAppRoot, disposeAppRoots, registerAppRoot } from '../../src/mount/app-roots.js';

describe('app roots', () => {
  afterEach(() => {
    disposeAppRoots();
    sentry.captureException.mockClear();
  });

  it('As the shell, disposing a root runs its disposer exactly once', () => {
    // Given
    const dispose = vi.fn();
    registerAppRoot('page', dispose);

    // When
    disposeAppRoot('page');
    disposeAppRoot('page');
    disposeAppRoots();

    // Then
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('As the shell, disposing a root that was never registered does nothing', () => {
    // When / Then
    expect(() => {
      disposeAppRoot('loading');
      disposeAppRoots();
    }).not.toThrow();
  });

  it('As the shell, disposing one root leaves the other live', () => {
    // Given
    const page = vi.fn();
    const loading = vi.fn();
    registerAppRoot('page', page);
    registerAppRoot('loading', loading);

    // When
    disposeAppRoot('page');

    // Then
    expect(page).toHaveBeenCalledTimes(1);
    expect(loading).not.toHaveBeenCalled();
  });

  it('As the shell, disposing every root runs each live disposer once', () => {
    // Given
    const page = vi.fn();
    const loading = vi.fn();
    registerAppRoot('page', page);
    registerAppRoot('loading', loading);

    // When
    disposeAppRoots();
    disposeAppRoots();

    // Then
    expect(page).toHaveBeenCalledTimes(1);
    expect(loading).toHaveBeenCalledTimes(1);
  });

  it('As the shell, registering a root again disposes the one it replaces', () => {
    // Given
    const first = vi.fn();
    const second = vi.fn();
    registerAppRoot('page', first);

    // When
    registerAppRoot('page', second);

    // Then
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    // When
    disposeAppRoot('page');

    // Then
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('As the shell, replacing a root that was already disposed does not dispose it again', () => {
    // Given
    const first = vi.fn();
    registerAppRoot('loading', first);
    disposeAppRoot('loading');

    // When
    registerAppRoot('loading', vi.fn());

    // Then
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('As the shell, a disposer that disposes its own root again runs once', () => {
    // Given
    const dispose = vi.fn(() => {
      disposeAppRoot('page');
    });
    registerAppRoot('page', dispose);

    // When
    disposeAppRoots();

    // Then
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('As the shell, disposing every root runs the page disposer before the loading one', () => {
    // Given
    const order: string[] = [];
    registerAppRoot('loading', () => order.push('loading'));
    registerAppRoot('page', () => order.push('page'));

    // When
    disposeAppRoots();

    // Then
    expect(order).toEqual(['page', 'loading']);
  });

  it('As the shell, a throwing page disposer is reported once and the loading root is still disposed', () => {
    // Given
    const failure = new Error('page teardown failed');
    const page = vi.fn(() => {
      throw failure;
    });
    const loading = vi.fn();
    registerAppRoot('page', page);
    registerAppRoot('loading', loading);

    // When
    expect(() => {
      disposeAppRoots();
    }).not.toThrow();
    disposeAppRoots();

    // Then the failed root counts as disposed
    expect(page).toHaveBeenCalledTimes(1);
    expect(loading).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(failure, {
      flow: 'ui',
      step: 'root_dispose',
      tags: { root: 'page', kind: 'app_root_dispose_error' },
    });
  });

  it('As the shell, a root registered by the disposer it replaces is disposed too', () => {
    // Given
    const replacement = vi.fn();
    registerAppRoot('loading', () => {
      registerAppRoot('loading', replacement);
    });
    const latest = vi.fn();

    // When
    registerAppRoot('loading', latest);

    // Then
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(latest).not.toHaveBeenCalled();

    // When
    disposeAppRoot('loading');

    // Then
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it('As a root, the disposer registering returns runs once and leaves a newer root under its name alone', () => {
    // Given
    const first = vi.fn();
    const disposeFirst = registerAppRoot('page', first);
    disposeFirst();
    const second = vi.fn();
    registerAppRoot('page', second);

    // When
    disposeFirst();

    // Then
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    // When
    disposeAppRoot('page');

    // Then
    expect(second).toHaveBeenCalledTimes(1);
  });
});
