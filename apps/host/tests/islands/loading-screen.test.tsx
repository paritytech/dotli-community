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
import * as ctl from '../../src/loading-controller.js';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { getLoadingState, updateLoading } from '../../src/state/loading.js';
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

// The status typewriter (loading-controller.ts) runs on animation frames,
// which the tests hold so it never types.
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;

function app(): HTMLElement {
  return byId('app');
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  frames = new Map();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    nextFrame += 1;
    frames.set(nextFrame, cb);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
  app().replaceChildren();
  captures.exception.mockClear();
});

afterEach(() => {
  for (const dispose of mounted.splice(0).reverse()) {
    dispose();
  }
  ctl.stopStatusTick();
  resetAllStoresForTests();
  app().innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Loading screen island', () => {
  it('As the shell, mounting the island does not dispose the running load', async () => {
    // Given a crawling bar
    ctl.initPhases([{ label: 'a', base: 5, target: 90, expectedMs: 10_000, stage: 'relay' }]);
    ctl.advancePhase(0);

    // When
    await mountScreen();
    const before = getLoadingState().progress;
    vi.advanceTimersByTime(1_000);
    await settle();

    // Then the crawl goes on, into the live screen
    expect(getLoadingState().phase).toBe('active');
    expect(getLoadingState().progress).toBeGreaterThan(before);
    expect(byId('loading-progress-pct').textContent).toBe(`${String(Math.round(getLoadingState().progress))}%`);
  });

  it('As the shell, content written over `#app` leaves the live screen, which still follows the store', async () => {
    // Given
    await mountScreen();
    const screen = byId('app-loading');

    // When the bridge clears `#app` for the product frame
    app().innerHTML = '';
    updateLoading({ progress: 80 });
    await settle();

    // Then
    expect(byId('app-loading')).toBe(screen);
    expect(byId('loading-progress-pct').textContent).toBe('80%');
  });
});
