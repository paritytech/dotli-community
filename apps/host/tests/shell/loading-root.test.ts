// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindCaptureSink, captureException } from '@dotli/metrics';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { showErrorPage } from '../../src/error-page.js';
import { showNoContentError } from '../../src/no-content-page.js';
import { disposeContentRoots, prefersReducedMotion, registerAppRoot } from '@dotli/ui-core';
import { createLoadingController, type LoadingController, type LoadingPhase } from '../../src/loading-controller.js';
import { getLoadingState } from '../../src/state/loading.js';

const captures = { exception: vi.fn(), expected: vi.fn() };
bindCaptureSink(captures);

// Mirror of PROGRESS_STALL_MS in loading-controller.ts.
const STALL_MS = 4_000;

// One long clock-driven band, so the crawl moves the bar on every tick.
const PHASES: LoadingPhase[] = [
  {
    label: 'Connecting',
    base: 5,
    target: 90,
    expectedMs: 60_000,
    stage: 'relay',
  },
];

function installLoadingDom(): void {
  document.body.innerHTML = `
    <div id="app-loading">
      <div id="loading-progress">
        <div id="loading-progress-fill"></div>
        <span id="loading-progress-pct">0%</span>
      </div>
      <p id="status"></p>
      <p id="status-sr"></p>
    </div>
    <div id="app"></div>`;
}

describe('The loading screen is a tracked app root', () => {
  let ctl: LoadingController;

  beforeEach(() => {
    vi.useFakeTimers();
    installLoadingDom();
    // Whatever an earlier controller registered goes first, so this one starts on a live screen, as the page's does.
    disposeContentRoots();
    resetAllStoresForTests();
    ctl = createLoadingController({
      reducedMotion: prefersReducedMotion,
      frames: {
        request: step => requestAnimationFrame(step),
        cancel: handle => {
          cancelAnimationFrame(handle);
        },
        now: () => performance.now(),
      },
    });
  });

  afterEach(() => {
    disposeContentRoots();
    captures.exception.mockClear();
    vi.useRealTimers();
  });

  const progress = (): number => getLoadingState().progress;

  function startLoading(): void {
    ctl.initPhases(PHASES);
    ctl.advancePhase(0);
    // Prove the crawl really is running before anything stops it.
    const before = progress();
    vi.advanceTimersByTime(1_000);
    expect(progress()).not.toBe(before);
  }

  it.each([
    ['an error page', () => showErrorPage({ title: 'Failed' })],
    ['a no-content page', () => showNoContentError('nothing')],
  ])('As a visitor, %s stops the loading bar and its stall watch behind it', async (_name, show) => {
    // Given a crawling bar with a stall watch
    const onStall = vi.fn();
    ctl.onProgressStall(onStall);
    startLoading();

    // When
    await show();
    const frozen = progress();
    vi.advanceTimersByTime(STALL_MS * 5);

    // Then no crawl tick or stall lands after the error
    expect(progress()).toBe(frozen);
    expect(onStall).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="error-page-title"]')).not.toBeNull();
  });

  it.each([
    ['an error page', () => showErrorPage({ title: 'Failed' })],
    ['a no-content page', () => showNoContentError('nothing')],
  ])('As a visitor, %s shown before the load starts takes the static screen down', async (_name, show) => {
    // Given the static screen, with no phases started

    // When
    await show();

    // Then
    expect(getLoadingState().phase).toBe('gone');
    expect(vi.getTimerCount()).toBe(0);
    expect(document.querySelector('[data-testid="error-page-title"]')).not.toBeNull();
  });

  it('As the shell, an error page disposes the page and loading roots before it replaces #app', async () => {
    // Given
    const seen: string[] = [];
    const record = (name: string) => () => {
      // Disposal comes first, while the old content is still in place.
      expect(document.querySelector('[data-testid="error-page"]')).toBeNull();
      seen.push(name);
    };
    // Registered loading first, so the newer page root goes first.
    registerAppRoot('loading', record('loading'), captureException, { content: true });
    registerAppRoot('page', record('page'), captureException, { content: true });

    // When
    await showErrorPage({ title: 'Failed' });

    // Then
    expect(seen).toEqual(['page', 'loading']);
    expect(document.querySelector('[data-testid="error-page"]')).not.toBeNull();
  });

  it('As the shell, the no-content page disposes the page and loading roots before it replaces #app', async () => {
    // Given
    const seen: string[] = [];
    const record = (name: string) => () => {
      expect(document.querySelector('[data-testid="error-page"]')).toBeNull();
      seen.push(name);
    };
    // Registered loading first, so the newer page root goes first.
    registerAppRoot('loading', record('loading'), captureException, { content: true });
    registerAppRoot('page', record('page'), captureException, { content: true });

    // When
    await showNoContentError('nothing');

    // Then
    expect(seen).toEqual(['page', 'loading']);
    expect(document.querySelector('[data-testid="error-page"]')).not.toBeNull();
  });

  it.each([
    ['error page', () => showErrorPage({ title: 'Failed' })],
    ['no-content page', () => showNoContentError('nothing')],
  ])('As a visitor, the %s still renders when the page root fails to dispose', async (_name, show) => {
    // Given
    const failure = new Error('page teardown failed');
    registerAppRoot(
      'page',
      () => {
        throw failure;
      },
      captureException,
      { content: true },
    );
    ctl.initPhases(PHASES);

    // When
    await show();

    // Then the loading root is still disposed and the error page is up
    expect(getLoadingState().phase).toBe('gone');
    expect(document.querySelector('[data-testid="error-page-title"]')).not.toBeNull();
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(failure, {
      flow: 'ui',
      step: 'root_dispose',
      tags: { root: 'page', kind: 'app_root_dispose_error' },
    });
  });
});
