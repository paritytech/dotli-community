// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The loading screen island (components/shell/LoadingScreen.tsx), mounted in
// an island element through the Astro renderer's client entry, as the host
// page mounts it, rendering the loading store the controller writes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
import { flush } from 'solid-js';

// ui.ts binds `#app` when it loads, so the element exists before any import
// runs and every test only ever replaces its children.
vi.hoisted(() => {
  document.body.innerHTML = `<div id="app"></div>`;
});

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../../../metrics/src/sentry.js', () => sentry);
// The landing page loads the recent names from the shared storage frame,
// which happy-dom would try to fetch.
vi.mock('../../../src/recent-labels.js', () => ({
  loadRecentLabels: () => Promise.resolve([]),
  forgetRecentLabel: () => Promise.resolve(),
}));

import client from '@dotli/astro-solid/client.js';
import { LoadingScreen } from '../../../src/islands/LoadingScreen.js';
import * as ctl from '../../../src/loading-controller.js';
import { disposeAppRoot, disposeAppRoots } from '../../../src/mount/app-roots.js';
import { resetAllStoresForTests } from '../../../src/state/create-store.js';
import { getLoadingState, updateLoading } from '../../../src/state/loading.js';
import { showErrorPage } from '../../../src/ui.js';
import { showLanding } from '../../../src/landing/load.js';
import { byId } from '../../support.js';
import { nth } from '../../helpers/nth.js';

/**
 * Mount the loading screen in an island element before `#app`, as the host
 * page does (client-rendered: the tests compile Solid for the DOM only).
 */
async function mountScreen(): Promise<HTMLElement> {
  const island = document.createElement('astro-island');
  island.setAttribute('ssr', '');
  app().before(island);
  client(island)(LoadingScreen, {}, {}, { client: 'only' });
  await settle();
  return island;
}

const FADE_MS = 300;

// The status typewriter (loading-controller.ts) runs on animation frames,
// which the tests step by hand.
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;

/** Run every animation frame requested so far, at `now`. */
function runFrames(now: number): void {
  const due = [...frames];
  frames.clear();
  for (const [, cb] of due) {
    cb(now);
  }
}

function app(): HTMLElement {
  return byId('app');
}

function petals(root: ParentNode = document): SVGPathElement[] {
  return [...root.querySelectorAll<SVGPathElement>('.loading-petal')];
}

const BASE_CSS = readFileSync(resolve(import.meta.dirname, '../../../src/styles/base.css'), 'utf8');

/** A CSS time (`-1.2s`, `200ms`) in milliseconds. */
function toMs(time: string): number {
  return time.endsWith('ms') ? parseFloat(time) : parseFloat(time) * 1_000;
}

/**
 * The animation a browser with `motion` as its reduced-motion preference
 * applies to each petal of `markup`, under styles/base.css. A window of its
 * own, so the preference and the stylesheet stay out of the test document.
 */
async function petalAnimations(
  markup: string,
  motion: 'no-preference' | 'reduce',
): Promise<{ animation: string; delayMs: number }[]> {
  const win = new Window({
    settings: { device: { prefersReducedMotion: motion } },
  });
  const style = win.document.createElement('style');
  style.textContent = BASE_CSS;
  win.document.head.append(style);
  win.document.body.innerHTML = markup;
  const result = [...win.document.querySelectorAll('.loading-petal')].map(petal => {
    const computed = win.getComputedStyle(petal);
    return {
      animation: computed.animation,
      delayMs: toMs(computed.animationDelay || '0s'),
    };
  });
  await win.happyDOM.close();
  return result;
}

async function settle(): Promise<void> {
  flush();
  await Promise.resolve();
  flush();
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
  for (const island of document.querySelectorAll('astro-island')) {
    island.remove();
  }
  sentry.captureException.mockClear();
});

afterEach(() => {
  disposeAppRoots();
  ctl.stopStatusTick();
  resetAllStoresForTests();
  app().innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Loading screen island', () => {
  it('As a visitor, progress, status and warning made before it hydrates show at once, and nothing restarts', async () => {
    // Given a load already underway
    updateLoading({
      progress: 37.4,
      statusText: 'Downloading the app',
      statusOpacity: 0.8,
      srText: 'Downloading the app',
      warning: 'Still looking for peers',
    });
    const before = getLoadingState();

    // When
    await mountScreen();

    // Then, straight from the first render
    expect(byId('loading-progress-fill').style.width).toBe('37.4%');
    expect(byId('loading-progress-pct').textContent).toBe('37%');
    expect(byId('loading-progress').getAttribute('aria-valuenow')).toBe('37');
    expect(byId('status').textContent).toBe('Downloading the app');
    expect(byId('status').style.opacity).toBe('0.8');
    expect(byId('status-sr').textContent).toBe('Downloading the app');
    expect(byId('loading-warning').classList.contains('visible')).toBe(true);
    expect(byId('loading-warning-text').textContent).toBe('Still looking for peers');
    await settle();
    expect(getLoadingState()).toEqual(before);
  });

  it('As a visitor, the loading screen follows the store', async () => {
    // Given
    await mountScreen();

    // When
    updateLoading({
      progress: 62.6,
      statusText: 'Connecting to',
      statusOpacity: 0.9,
      srText: 'Connecting to Polkadot',
      warning: 'Slow <b>peers</b>',
    });
    await settle();

    // Then
    expect(byId('loading-progress-fill').style.width).toBe('62.6%');
    expect(byId('loading-progress-pct').textContent).toBe('63%');
    expect(byId('loading-progress').getAttribute('aria-valuenow')).toBe('63');
    expect(byId('status').textContent).toBe('Connecting to');
    expect(byId('status').style.opacity).toBe('0.9');
    expect(byId('status-sr').textContent).toBe('Connecting to Polkadot');
    const warning = byId('loading-warning');
    expect(warning.classList.contains('visible')).toBe(true);
    expect(warning.classList.contains('loading-warning')).toBe(true);
    // A warning is text, never markup.
    expect(byId('loading-warning-text').textContent).toBe('Slow <b>peers</b>');
    expect(warning.querySelector('b')).toBeNull();

    // When
    updateLoading({ warning: null });
    await settle();

    // Then
    expect(warning.classList.contains('visible')).toBe(false);
    expect(byId('loading-warning-text').textContent).toBe('');
  });

  it('As a visitor whose app loaded, the loading screen fades, then goes after 300 ms with its root', async () => {
    // Given
    ctl.initPhases([{ label: 'a', base: 0, target: 50, expectedMs: 5_000, stage: 'relay' }]);
    ctl.advancePhase(0);
    await mountScreen();
    const screen = byId('app-loading');

    // When
    ctl.dismissLoading();
    await settle();

    // Then
    expect(screen.style.transition).toBe('opacity 0.3s ease');
    expect(screen.style.opacity).toBe('0');
    expect(screen.style.pointerEvents).toBe('none');
    expect(byId('loading-progress-pct').textContent).toBe('100%');
    expect(screen.isConnected).toBe(true);

    // When
    vi.advanceTimersByTime(FADE_MS - 1);
    await settle();

    // Then
    expect(screen.isConnected).toBe(true);

    // When
    vi.advanceTimersByTime(1);
    await settle();

    // Then the node is gone and the island no longer follows the store
    expect(screen.isConnected).toBe(false);
    expect(document.getElementById('app-loading')).toBeNull();
    expect(getLoadingState().phase).toBe('gone');
    updateLoading({ statusText: 'late line' });
    await settle();
    expect(screen.querySelector('#status')?.textContent).not.toBe('late line');
    expect(frames.size).toBe(0);
  });

  it('As a visitor whose load failed, the error page disposes the loading screen and its timers', async () => {
    // Given a crawling bar under the live screen
    ctl.initPhases([{ label: 'a', base: 5, target: 90, expectedMs: 60_000, stage: 'relay' }]);
    ctl.advancePhase(0);
    await mountScreen();
    const screen = byId('app-loading');
    runFrames(100);
    // The typewriter's next frame.
    expect(frames.size).toBe(1);

    // When
    showErrorPage({ title: 'Failed' });
    const frozen = getLoadingState().progress;
    vi.advanceTimersByTime(10_000);
    await settle();

    // Then
    expect(screen.isConnected).toBe(false);
    expect(getLoadingState().phase).toBe('gone');
    expect(getLoadingState().progress).toBe(frozen);
    expect(frames.size).toBe(0);
    expect(document.querySelector('.error-page-title')?.textContent).toBe('Failed');
  });

  it('As a visitor, the landing page disposes a loading screen mounted before it', async () => {
    // Given: a load underway, which makes the screen the loading root.
    await mountScreen();
    ctl.initPhases([{ label: 'a', base: 5, target: 90, expectedMs: 60_000, stage: 'relay' }]);
    const screen = byId('app-loading');
    runFrames(100);

    // When
    await showLanding();
    await settle();

    // Then
    expect(screen.isConnected).toBe(false);
    expect(getLoadingState().phase).toBe('gone');
    expect(frames.size).toBe(0);
  });

  it('As a visitor, the petals are animated by the stylesheet alone, with no frames or inline styles', async () => {
    // When
    await mountScreen();
    runFrames(100);

    // Then
    expect(petals()).toHaveLength(6);
    expect(petals().every(p => !p.hasAttribute('style'))).toBe(true);
    expect(frames.size).toBe(0);
  });

  it('As a visitor, the petals of the loading screen light up in turn, a sixth of a cycle apart, and stay still under reduced motion', async () => {
    // Given
    await mountScreen();
    const screens = {
      live: byId('app-loading').outerHTML,
    };

    for (const [name, markup] of Object.entries(screens)) {
      // When: no motion preference.
      const moving = await petalAnimations(markup, 'no-preference');

      // Then
      expect(moving, name).toHaveLength(6);
      for (const [i, petal] of moving.entries()) {
        expect(petal.animation, `${name} petal ${String(i)}`).toMatch(/^loading-petal \S+ .*infinite$/);
        const cycleMs = toMs(nth(petal.animation.split(' '), 1));
        const offset = ((petal.delayMs % cycleMs) + cycleMs) % cycleMs;
        expect(offset, `${name} petal ${String(i)}`).toBeCloseTo((i * cycleMs) / 6, 2);
      }

      // When: reduced motion.
      const still = await petalAnimations(markup, 'reduce');

      // Then
      expect(
        still.map(petal => petal.animation),
        name,
      ).toEqual(Array(6).fill(''));
    }
  });

  it('As the shell, disposing the loading root stops the loading timers and the screen goes', async () => {
    // Given
    const onStall = vi.fn();
    ctl.initPhases([
      {
        label: 'a',
        base: 10,
        target: 90,
        expectedMs: 10_000,
        stage: 'content',
        reportsProgress: true,
      },
    ]);
    ctl.onProgressStall(onStall);
    ctl.advancePhase(0);
    await mountScreen();
    const screen = byId('app-loading');

    // When
    disposeAppRoot('loading');
    vi.advanceTimersByTime(20_000);
    await settle();

    // Then
    expect(screen.isConnected).toBe(false);
    expect(onStall).not.toHaveBeenCalled();
    expect(getLoadingState().phase).toBe('gone');
  });

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
