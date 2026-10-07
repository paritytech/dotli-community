// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveTldSuffix } from '@dotli/config';
import type { LoadingPhase } from '../src/loading-controller.js';
import type * as LoadingControllerModule from '../src/loading-controller.js';
import type * as LoadingModule from '../src/state/loading.js';

type Controller = typeof LoadingControllerModule;
type LoadingStateModule = typeof LoadingModule;

// Mirrors of the constants in loading-controller.ts.
const STALL_MS = 4_000;
const ROTATE_MS = 9_000;
const ERASE_MS = 1_400;
const TYPE_MS = 3_600;
const FADE_MS = 300;

const SANDBOX_ORIGIN = 'http://myapp.app.localhost:5173';

let reducedMotion = false;

function stubMotionPreference(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)' && reducedMotion,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function installLoadingDom(): void {
  document.body.innerHTML = `<div id="app-loading"></div><div id="app"></div>`;
}

describe('The loading controller drives the loading store', () => {
  let ctl: Controller;
  let store: LoadingStateModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    reducedMotion = false;
    stubMotionPreference();
    installLoadingDom();
    [ctl, store] = await Promise.all([import('../src/loading-controller.js'), import('../src/state/loading.js')]);
  });

  afterEach(async () => {
    const roots = await import('../src/mount/app-roots.js');
    roots.disposeAppRoots();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const progress = (): number => store.getLoadingState().progress;
  const explanation = (): string => store.getLoadingState().explanation;
  const step = (): readonly LoadingModule.StepPart[] => store.getLoadingState().step;

  /** Every distinct explanation the store held, in order. */
  function recordExplanations(): string[] {
    const seen: string[] = [explanation()];
    store.loadingStore.subscribe(() => {
      const text = explanation();
      if (text !== seen[seen.length - 1]) {
        seen.push(text);
      }
    });
    return seen;
  }

  it("As a visitor, the bar crawls across a step in about its expected time, then creeps into the next step's headroom", () => {
    // Given one 10s step followed by a step reaching 60
    const phases: LoadingPhase[] = [
      { label: 'a', base: 0, target: 40, expectedMs: 10_000, stage: 'relay' },
      {
        label: 'b',
        base: 40,
        target: 60,
        expectedMs: 5_000,
        stage: 'assetHub',
      },
    ];
    ctl.initPhases(phases);

    // When
    ctl.advancePhase(0);
    vi.advanceTimersByTime(5_000);

    // Then about halfway across the band
    expect(progress()).toBeGreaterThan(15);
    expect(progress()).toBeLessThan(25);

    // When the step overruns its expected time
    vi.advanceTimersByTime(5_000);

    // Then the crawl has reached the band's target
    expect(progress()).toBeCloseTo(40, 5);

    // When it keeps overrunning
    vi.advanceTimersByTime(60_000);

    // Then it has crept into the next band, but never past its target
    expect(progress()).toBeGreaterThan(40);
    expect(progress()).toBeLessThanOrEqual(60);
  });

  it('As a visitor, the creep stops short of a full bar on the last step', () => {
    // Given
    ctl.initPhases([{ label: 'a', base: 0, target: 90, expectedMs: 1_000, stage: 'content' }]);

    // When
    ctl.advancePhase(0);
    vi.advanceTimersByTime(10 * 60_000);

    // Then
    expect(progress()).toBe(99);
  });

  it("As a visitor, a stage's step line stays up while its explanations cycle under it", () => {
    // Given
    reducedMotion = true;
    const seen = recordExplanations();

    // When
    ctl.setLoadingStage('relay');

    // Then the step line shows at once, with no explanation yet
    expect(step()).toEqual(['Connecting to Polkadot']);
    expect(explanation()).toBe('');
    expect(store.getLoadingState().srText).toBe('Connecting to Polkadot');

    // When
    vi.advanceTimersByTime(ROTATE_MS * 5);

    // Then
    expect(step()).toEqual(['Connecting to Polkadot']);
    expect(seen.slice(1)).toEqual([
      'Looking for other computers to talk to',
      'Your browser does the checking itself, not a server',
      'Looking for other computers to talk to',
      'Your browser does the checking itself, not a server',
      'Looking for other computers to talk to',
    ]);
    expect(store.getLoadingState().srText).toBe('Looking for other computers to talk to');
  });

  it('As a visitor, the step line names the domain with its TLD apart, and a screen reader hears it whole', () => {
    // Given
    ctl.setLoadingDomain('myapp');

    // When
    ctl.setLoadingStage('assetHub');

    // Then
    expect(step()).toEqual(['Looking up ', { host: 'myapp', tld: getActiveTldSuffix() }]);
    expect(store.getLoadingState().srText).toBe(`Looking up myapp${getActiveTldSuffix()}`);
  });

  it('As a visitor on the preview path, the step line says "the name" when there is no domain', () => {
    // When
    ctl.setLoadingStage('assetHub');

    // Then
    expect(step()).toEqual(['Looking up ', 'the name']);
  });

  it('As a visitor, the explanation types in frame by frame, and the next one erases it first', () => {
    // Given
    const seen = recordExplanations();
    ctl.setLoadingStage('relay');

    // When the first explanation is due and has had time to type
    vi.advanceTimersByTime(ROTATE_MS + TYPE_MS + 100);

    // Then it typed in a piece at a time from empty
    expect(seen).toContain('Look');
    expect(explanation()).toBe('Looking for other computers to talk to');
    expect(store.getLoadingState().explanationOpacity).toBe(1);

    // When the next turn has erased the line and typed the next one
    vi.advanceTimersByTime(ROTATE_MS + ERASE_MS);

    // Then
    expect(seen).toContain('Looking for');
    expect(seen).toContain('Your');
    expect(explanation()).toBe('Your browser does the checking itself, not a server');
  });

  it("As a visitor, a new stage swaps the step line at once and drops the last stage's explanation mid-type", () => {
    // Given an explanation half typed
    ctl.setLoadingStage('relay');
    vi.advanceTimersByTime(ROTATE_MS + TYPE_MS / 2);
    expect(explanation()).not.toBe('');

    // When
    ctl.setLoadingStage('resolving');

    // Then
    expect(step()).toEqual(['Found it']);
    expect(explanation()).toBe('');
    expect(store.getLoadingState().explanationOpacity).toBe(1);
    expect(store.getLoadingState().srText).toBe('Found it');

    // When time passes short of the next turn
    vi.advanceTimersByTime(ROTATE_MS - 100);

    // Then nothing of the old stage was typed back in
    expect(explanation()).toBe('');
  });

  it('As a visitor who prefers reduced motion, the explanation changes at once', () => {
    // Given
    reducedMotion = true;
    ctl.setLoadingStage('relay');

    // When
    vi.advanceTimersByTime(ROTATE_MS);

    // Then
    expect(explanation()).toBe('Looking for other computers to talk to');
    expect(store.getLoadingState().srText).toBe('Looking for other computers to talk to');
  });

  it('As a visitor whose load parked, the stall watch fires with the percentage', () => {
    // Given
    const onStall = vi.fn();
    ctl.initPhases([
      {
        label: 'Fetching content',
        base: 10,
        target: 90,
        expectedMs: 10_000,
        stage: 'content',
        reportsProgress: true,
      },
    ]);
    ctl.onProgressStall(onStall);

    // When
    ctl.advancePhase(0);
    vi.advanceTimersByTime(STALL_MS + 100);

    // Then
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall).toHaveBeenCalledWith(10);
  });

  it('As a visitor, a stall warning is shown and cleared', () => {
    // When
    ctl.setLoadingWarning('Still looking for peers');

    // Then
    expect(store.getLoadingState().warning).toBe('Still looking for peers');

    // When
    ctl.setLoadingWarning(null);

    // Then
    expect(store.getLoadingState().warning).toBeNull();
  });

  it('As a visitor whose app loaded, the loading screen fills, fades, then goes after 300 ms', () => {
    // Given
    ctl.initPhases([{ label: 'a', base: 0, target: 50, expectedMs: 5_000, stage: 'relay' }]);
    ctl.advancePhase(0);

    // When
    ctl.dismissLoading();

    // Then
    expect(store.getLoadingState().phase).toBe('dismissing');
    expect(progress()).toBe(100);

    // When
    vi.advanceTimersByTime(FADE_MS - 1);

    // Then
    expect(store.getLoadingState().phase).toBe('dismissing');

    // When
    vi.advanceTimersByTime(1);

    // Then
    expect(store.getLoadingState().phase).toBe('gone');
  });

  it("As a visitor, the sandbox's done message dismisses the loading screen and runs the done callbacks with its outcome", () => {
    // Given
    const onDone = vi.fn();
    ctl.listenForSandboxStatus();
    ctl.onSandboxDone(onDone);

    // When
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'dotli:loading-status', done: true, outcome: 'loaded' },
        origin: SANDBOX_ORIGIN,
      }),
    );

    // Then
    expect(store.getLoadingState().phase).toBe('dismissing');
    expect(onDone).toHaveBeenCalledExactlyOnceWith('loaded', undefined);
  });

  it('As the shell, a sandbox that failed to load its content reports the failure and the step it stopped at', () => {
    // Given
    const onDone = vi.fn();
    ctl.listenForSandboxStatus();
    ctl.onSandboxDone(onDone);

    // When
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'dotli:loading-status', done: true, outcome: 'failed', failedStep: 'content_fetch' },
        origin: SANDBOX_ORIGIN,
      }),
    );

    // Then
    expect(store.getLoadingState().phase).toBe('dismissing');
    expect(onDone).toHaveBeenCalledExactlyOnceWith('failed', 'content_fetch');
  });

  it('As the shell, a failed step that is not a short token is dropped before it can become a tag', () => {
    // Given
    const onDone = vi.fn();
    ctl.listenForSandboxStatus();
    ctl.onSandboxDone(onDone);

    // When
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'dotli:loading-status', done: true, outcome: 'failed', failedStep: 'Failed: <script>' },
        origin: SANDBOX_ORIGIN,
      }),
    );

    // Then
    expect(onDone).toHaveBeenCalledExactlyOnceWith('failed', undefined);
  });

  it('As a visitor at a password prompt, the loading screen is dismissed while the done callbacks keep waiting for the content', () => {
    // Given
    const onDone = vi.fn();
    ctl.listenForSandboxStatus();
    ctl.onSandboxDone(onDone);

    // When
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'dotli:loading-status', done: true },
        origin: SANDBOX_ORIGIN,
      }),
    );

    // Then
    expect(store.getLoadingState().phase).toBe('dismissing');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('As a visitor, a done message from any other origin is ignored', () => {
    // Given
    const onDone = vi.fn();
    ctl.listenForSandboxStatus();
    ctl.onSandboxDone(onDone);

    // When
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'dotli:loading-status', done: true, outcome: 'loaded' },
        origin: 'https://attacker.example',
      }),
    );

    // Then
    expect(store.getLoadingState().phase).toBe('active');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('As the shell, disposing the loading root stops every loading timer and marks the screen gone', async () => {
    // Given a crawling bar, a rotating explanation and an armed stall watch
    const onStall = vi.fn();
    ctl.initPhases([{ label: 'a', base: 5, target: 90, expectedMs: 60_000, stage: 'relay' }]);
    ctl.onProgressStall(onStall);
    ctl.advancePhase(0);
    vi.advanceTimersByTime(1_000);
    const roots = await import('../src/mount/app-roots.js');

    // When
    roots.disposeAppRoot('loading');
    const frozen = store.getLoadingState();
    vi.advanceTimersByTime(ROTATE_MS * 5);

    // Then
    expect(frozen.phase).toBe('gone');
    expect(store.getLoadingState()).toEqual(frozen);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('As the shell, a late signal after the loading root was disposed starts no timer', async () => {
    // Given a load whose screen has gone
    ctl.initPhases([
      { label: 'a', base: 5, target: 50, expectedMs: 60_000, stage: 'relay' },
      {
        label: 'b',
        base: 50,
        target: 90,
        expectedMs: 60_000,
        stage: 'content',
      },
    ]);
    ctl.advancePhase(0);
    const roots = await import('../src/mount/app-roots.js');
    roots.disposeAppRoot('loading');
    expect(vi.getTimerCount()).toBe(0);

    // When late signals arrive: content bytes, a progress fraction and a
    // phase change
    ctl.setLoadingStage('preparing');
    ctl.advancePhase(1);
    ctl.nudgePhaseProgress(0.5, 'content');

    // Then no rotation, typing frame, crawl or stall watch was started
    expect(vi.getTimerCount()).toBe(0);
    expect(store.getLoadingState().phase).toBe('gone');
  });

  it('As the shell, the static screen is the loading root from the moment the controller loads', async () => {
    // Given a controller that has started nothing
    const roots = await import('../src/mount/app-roots.js');

    // When whatever replaces the screen disposes the roots
    roots.disposeAppRoots();

    // Then the screen is gone
    expect(store.getLoadingState().phase).toBe('gone');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('As the shell, starting the phases keeps the root the controller registered on load', async () => {
    // When
    ctl.initPhases([{ label: 'a', base: 5, target: 90, expectedMs: 60_000, stage: 'relay' }]);
    ctl.advancePhase(0);

    // Then the screen is still up and the load is running
    expect(store.getLoadingState().phase).toBe('active');

    // When
    const roots = await import('../src/mount/app-roots.js');
    roots.disposeAppRoot('loading');

    // Then one root, disposed once
    expect(store.getLoadingState().phase).toBe('gone');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('As the shell, the loading screen is a root from the start, so a page shown before any phase takes it down', async () => {
    // Given the controller, freshly loaded, before any phase
    vi.resetModules();
    const [freshStore, roots] = await Promise.all([
      import('../src/state/loading.js'),
      import('../src/mount/app-roots.js'),
      import('../src/loading-controller.js'),
    ]);

    // When
    roots.disposeAppRoots();

    // Then
    expect(freshStore.getLoadingState().phase).toBe('gone');
  });

  it('As a visitor whose app loaded, the dismiss stops the explanation rotation and the typing', () => {
    // Given an explanation mid-turn
    ctl.initPhases([{ label: 'a', base: 5, target: 90, expectedMs: 60_000, stage: 'relay' }]);
    ctl.advancePhase(0);
    vi.advanceTimersByTime(ROTATE_MS + TYPE_MS / 2);
    const midTurn = explanation();

    // When
    ctl.dismissLoading();
    vi.advanceTimersByTime(FADE_MS);

    // Then nothing is left running and the line no longer changes
    expect(store.getLoadingState().phase).toBe('gone');
    expect(vi.getTimerCount()).toBe(0);
    const settled = explanation();
    vi.advanceTimersByTime(ROTATE_MS * 3);
    expect(explanation()).toBe(settled);
    expect(store.getLoadingState().explanationOpacity).toBe(1);
    expect(midTurn).not.toBe('');
  });

  it('As a visitor, a second done message from the sandbox runs the done callbacks only once', () => {
    // Given
    const onDone = vi.fn();
    ctl.listenForSandboxStatus();
    ctl.onSandboxDone(onDone);
    const done = (): void => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'dotli:loading-status', done: true, outcome: 'loaded' },
          origin: SANDBOX_ORIGIN,
        }),
      );
    };
    done();
    vi.advanceTimersByTime(FADE_MS);

    // When
    done();

    // Then
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(store.getLoadingState().phase).toBe('gone');
    expect(vi.getTimerCount()).toBe(0);
  });
});
