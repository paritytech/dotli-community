// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { clearScreen, pageContentStore, prefersReducedMotion, showErrorPage } from '@dotli/ui';
import { showNoContentError } from '../../src/no-content-page.js';
import {
  createLoadingController,
  PROGRESS_STALL_MS,
  type LoadingController,
  type LoadingPhase,
} from '../../src/loading-controller.js';
import { getLoadingState } from '../../src/state/loading.js';

bindCaptureSink({ exception: vi.fn(), expected: vi.fn() });

// One long clock-driven band, so the crawl moves the bar on every tick.
const PHASES: LoadingPhase[] = [{ label: 'Connecting', base: 5, target: 90, expectedMs: 60_000, stage: 'relay' }];

describe('A full-page screen ends the loading screen', () => {
  let ctl: LoadingController;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="app"></div>';
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
      pageContent: pageContentStore,
    });
  });

  afterEach(() => {
    clearScreen();
    ctl.stopStatusTick();
    vi.useRealTimers();
  });

  const progress = (): number => getLoadingState().progress;

  it.each([
    [
      'an error page',
      () => {
        showErrorPage({ title: 'Failed' });
      },
    ],
    [
      'a no-content page',
      () => {
        showNoContentError('nothing');
      },
    ],
  ])('As a visitor, %s stops the loading bar and its stall watch behind it', (_name, show) => {
    // Given a crawling bar with a stall watch
    const onStall = vi.fn();
    ctl.onProgressStall(onStall);
    ctl.initPhases(PHASES);
    ctl.advancePhase(0);
    const before = progress();
    vi.advanceTimersByTime(1_000);
    expect(progress()).not.toBe(before);

    // When
    show();
    const frozen = progress();
    vi.advanceTimersByTime(PROGRESS_STALL_MS * 5);

    // Then no crawl tick or stall lands after the screen
    expect(progress()).toBe(frozen);
    expect(onStall).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="error-page-title"]')).not.toBeNull();
  });

  it.each([
    [
      'an error page',
      () => {
        showErrorPage({ title: 'Failed' });
      },
    ],
    [
      'a no-content page',
      () => {
        showNoContentError('nothing');
      },
    ],
  ])('As a visitor, %s shown before the load starts takes the static screen down', (_name, show) => {
    // Given the static screen, with no phases started
    const onStall = vi.fn();
    ctl.onProgressStall(onStall);

    // When the screen shows, and the load starts behind it
    show();
    ctl.initPhases(PHASES);
    ctl.advancePhase(0);
    const frozen = progress();
    vi.advanceTimersByTime(PROGRESS_STALL_MS * 5);

    // Then the bar never moves and no stall fires
    expect(getLoadingState().phase).toBe('gone');
    expect(progress()).toBe(frozen);
    expect(onStall).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="error-page-title"]')).not.toBeNull();
  });
});
