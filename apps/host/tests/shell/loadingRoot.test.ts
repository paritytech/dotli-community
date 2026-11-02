// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { createManualTimers, resetAllStoresForTests } from '@dotli/shared/testing';
import { pageScreen, prefersReducedMotion, showErrorPage } from '@dotli/ui';
import { createManualPoll } from '../../src/testing/createManualPoll.js';
import { showNoContentError } from '../../src/showNoContentError.js';
import { createLoadingController, PROGRESS_STALL_MS, type LoadingPhase } from '../../src/createLoadingController.js';
import { loadingState } from '../../src/state/loadingState.js';

// One long clock-driven band, so the crawl moves the bar on every tick.
const PHASES: LoadingPhase[] = [{ label: 'Connecting', base: 5, target: 90, expectedMs: 60_000, stage: 'relay' }];

// The typed explanation's frames are held, so it never types and no real clock is read.
const HELD_FRAME = 0;

const FULL_PAGE_SCREENS: [string, () => void][] = [
  ['an error page', showFailedPage],
  ['a no-content page', showNothingPublishedPage],
];

describe('A full-page screen ends the loading screen', () => {
  it.each(FULL_PAGE_SCREENS)(
    'As a visitor, I get %s and the loading bar and its stall watch stop behind it',
    async (_name, show) => {
      // Given a crawling bar with a stall watch
      const { controller, timers } = setupLoadingPage();
      const onStall = vi.fn();
      controller.onProgressStall(onStall);
      controller.initPhases(PHASES);
      controller.advancePhase(0);
      const before = readProgress();
      await timers.advance(1_000);
      const crawled = readProgress();

      // When
      show();
      const frozen = readProgress();
      await timers.advance(PROGRESS_STALL_MS * 5);

      // Then no crawl tick or stall lands after the screen
      expect(crawled).not.toBe(before);
      expect(readProgress()).toBe(frozen);
      expect(onStall).not.toHaveBeenCalled();
      expect(document.querySelector('[data-testid="error-page-title"]')).not.toBeNull();
    },
  );

  it.each(FULL_PAGE_SCREENS)(
    'As a visitor, I get %s before the load starts and it takes the static screen down',
    async (_name, show) => {
      // Given the static screen, with no phases started
      const { controller, timers } = setupLoadingPage();
      const onStall = vi.fn();
      controller.onProgressStall(onStall);

      // When the screen shows, and the load starts behind it
      show();
      controller.initPhases(PHASES);
      controller.advancePhase(0);
      const frozen = readProgress();
      await timers.advance(PROGRESS_STALL_MS * 5);

      // Then the bar never moves and no stall fires
      expect(loadingState.get().phase).toBe('gone');
      expect(readProgress()).toBe(frozen);
      expect(onStall).not.toHaveBeenCalled();
      expect(document.querySelector('[data-testid="error-page-title"]')).not.toBeNull();
    },
  );
});

/** Builds a controller on the page's screen over fresh stores, disposed with the screen when the case ends. */
function setupLoadingPage() {
  const timers = createManualTimers();
  document.body.innerHTML = '<div id="app"></div>';
  resetAllStoresForTests();
  const unbindSink = bindCaptureSink({ exception: vi.fn(), expected: vi.fn() });
  const controller = createLoadingController({
    prefersReducedMotion,
    frames: {
      request: () => HELD_FRAME,
      cancel: () => undefined,
      now: timers.now,
    },
    pageContent: pageScreen.store,
    timers,
    poll: createManualPoll({ timers }),
  });
  onTestFinished(() => {
    controller.dispose();
    pageScreen.clear();
    unbindSink();
  });
  return {
    controller,
    /** The page's timers, which only the case moves. */
    timers,
  };
}

function showFailedPage(): void {
  showErrorPage({ title: 'Failed' });
}

function showNothingPublishedPage(): void {
  showNoContentError('nothing');
}

function readProgress(): number {
  return loadingState.get().progress;
}
