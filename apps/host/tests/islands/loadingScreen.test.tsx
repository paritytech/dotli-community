// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindCaptureSink } from '@dotli/metrics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';

// ui.ts binds `#app` when it loads, so the element exists before any import
// runs and every test only ever replaces its children.
vi.hoisted(() => {
  document.body.innerHTML = `<div id="app"></div>`;
});

const captures = { exception: vi.fn(), expected: vi.fn() };
bindCaptureSink(captures);

import { LoadingScreen } from '../../src/islands/LoadingScreen.js';
import { createLoadingController, type LoadingController } from '../../src/createLoadingController.js';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { loadingState } from '../../src/state/loadingState.js';
import { pageScreen, prefersReducedMotion } from '@dotli/ui';
import { byId, settle } from '@dotli/ui/testing';

const mounted: (() => void)[] = [];

async function mountScreen(): Promise<HTMLElement> {
  const slot = document.createElement('div');
  app().before(slot);
  mounted.push(
    () => {
      slot.remove();
    },
    render(() => <LoadingScreen />, slot),
  );
  await settle();
  return slot;
}

// The status typewriter runs on animation frames, which the controller is given held so it never types.
let frames: Map<number, (now: number) => void>;
let nextFrame = 0;
let ctl: LoadingController;

function app(): HTMLElement {
  return byId('app');
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  frames = new Map();
  ctl = createLoadingController({
    prefersReducedMotion,
    frames: {
      request: step => {
        nextFrame += 1;
        frames.set(nextFrame, step);
        return nextFrame;
      },
      cancel: handle => {
        frames.delete(handle);
      },
      now: () => 0,
    },
    pageContent: pageScreen.store,
  });
  app().replaceChildren();
  captures.exception.mockClear();
});

afterEach(() => {
  for (const dispose of mounted.splice(0).reverse()) {
    dispose();
  }
  ctl.dispose();
  resetAllStoresForTests();
  app().innerHTML = '';
  vi.useRealTimers();
});

describe('Loading screen island', () => {
  it('As the shell, mounting the island does not dispose the running load', async () => {
    // Given a crawling bar
    ctl.initPhases([{ label: 'a', base: 5, target: 90, expectedMs: 10_000, stage: 'relay' }]);
    ctl.advancePhase(0);

    // When
    await mountScreen();
    const before = loadingState.get().progress;
    vi.advanceTimersByTime(1_000);
    await settle();

    // Then the crawl goes on, into the live screen
    expect(loadingState.get().phase).toBe('active');
    expect(loadingState.get().progress).toBeGreaterThan(before);
    expect(byId('loading-progress-pct').textContent).toBe(`${String(Math.round(loadingState.get().progress))}%`);
  });

  it('As the shell, content written over `#app` leaves the live screen, which still follows the store', async () => {
    // Given
    await mountScreen();
    const screen = byId('app-loading');

    // When the bridge clears `#app` for the product frame
    app().innerHTML = '';
    loadingState.update({ progress: 80 });
    await settle();

    // Then
    expect(byId('app-loading')).toBe(screen);
    expect(byId('loading-progress-pct').textContent).toBe('80%');
  });
});
