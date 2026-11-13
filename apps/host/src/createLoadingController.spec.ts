// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { getActiveTldSuffix } from '@dotli/config';
import {
  createLoadingController,
  ERASE_MS,
  FADE_MS,
  MESSAGE_ROTATE_MS,
  PROGRESS_STALL_MS,
  TYPE_MS,
  type LoadingController,
  type LoadingPhase,
} from './createLoadingController.js';
import { atom, type WritableAtom } from 'nanostores';
import { nth, resetAllStoresForTests } from '@dotli/shared/testing';
import type { PageContent } from '@dotli/ui';
import { loadingState, type StepPart } from './state/loadingState.js';
import { bindReports } from './testing/bindReports.js';

/** A controller over a page of its own, disposed with its timers when the case ends. */
type Stand = {
  controller: LoadingController;
  pageContent: WritableAtom<PageContent>;
};

type ControllerParams = Parameters<typeof createLoadingController>[0];

type Params = {
  reducedMotion?: boolean;
  /** What fills the page, a plain atom unless given. */
  pageContent?: WritableAtom<PageContent>;
  /** Replace the faked frames and the page's faked timers and interval. */
  collaborators?: Partial<Pick<ControllerParams, 'frames' | 'timers' | 'poll'>>;
};

const STALL_PHASES: LoadingPhase[] = [
  {
    label: 'Starting',
    base: 0,
    target: 10,
    expectedMs: 500,
    stage: 'starting',
  },
  {
    label: 'Fetching content',
    base: 10,
    target: 90,
    expectedMs: 10_000,
    stage: 'content',
    reportsProgress: true,
  },
];

// One long clock-driven band.
const ROOT_PHASES: LoadingPhase[] = [{ label: 'Connecting', base: 5, target: 90, expectedMs: 60_000, stage: 'relay' }];

describe('The loading controller drives the loading store', () => {
  it("As a visitor, I wait through a step and see the bar crawl across it in about its expected time and then creep into the next step's headroom", () => {
    // Given one 10s step followed by a step reaching 60
    const { controller } = setupController();
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
    controller.initPhases(phases);

    // When
    controller.advancePhase(0);
    vi.advanceTimersByTime(5_000);

    // Then about halfway across the band
    expect(readProgress()).toBeGreaterThan(15);
    expect(readProgress()).toBeLessThan(25);

    // When the step overruns its expected time
    vi.advanceTimersByTime(5_000);

    // Then the crawl has reached the band's target
    expect(readProgress()).toBeCloseTo(40, 5);

    // When it keeps overrunning
    vi.advanceTimersByTime(60_000);

    // Then it has crept into the next band, but never past its target
    expect(readProgress()).toBeGreaterThan(40);
    expect(readProgress()).toBeLessThanOrEqual(60);
  });

  it('As a visitor, I wait long on the last step and the creep stops short of a full bar', () => {
    // Given
    const { controller } = setupController();
    controller.initPhases([{ label: 'a', base: 0, target: 90, expectedMs: 1_000, stage: 'content' }]);

    // When
    controller.advancePhase(0);
    vi.advanceTimersByTime(10 * 60_000);

    // Then
    expect(readProgress()).toBe(99);
  });

  it('As a visitor, I reach a stage and its step line stays up while its explanations cycle under it', () => {
    // Given
    const { controller } = setupController({ reducedMotion: true });
    const seen = recordExplanations();

    // When
    controller.setLoadingStage('relay');

    // Then the step line shows at once, with no explanation yet
    expect(readStep()).toEqual(['Connecting to Polkadot']);
    expect(readExplanation()).toBe('');
    expect(loadingState.get().srText).toBe('Connecting to Polkadot');

    // When
    vi.advanceTimersByTime(MESSAGE_ROTATE_MS * 5);

    // Then
    expect(readStep()).toEqual(['Connecting to Polkadot']);
    expect(seen.slice(1)).toEqual([
      'Looking for other computers to talk to',
      'Your browser does the checking itself, not a server',
      'Looking for other computers to talk to',
      'Your browser does the checking itself, not a server',
      'Looking for other computers to talk to',
    ]);
    expect(loadingState.get().srText).toBe('Looking for other computers to talk to');
  });

  it('As a visitor, I look up a domain and the step line shows its TLD apart while a screen reader hears it whole', () => {
    // Given
    const { controller } = setupController();
    controller.setLoadingDomain('myapp');

    // When
    controller.setLoadingStage('assetHub');

    // Then
    expect(readStep()).toEqual(['Looking up ', { host: 'myapp', tld: getActiveTldSuffix() }]);
    expect(loadingState.get().srText).toBe(`Looking up myapp${getActiveTldSuffix()}`);
  });

  it('As a visitor on the preview path, I look up a name with no domain and the step line says "the name"', () => {
    // Given
    const { controller } = setupController();

    // When
    controller.setLoadingStage('assetHub');

    // Then
    expect(readStep()).toEqual(['Looking up ', 'the name']);
  });

  it('As a visitor, I watch an explanation type in frame by frame and the next one erases it first', () => {
    // Given
    const { controller } = setupController();
    const seen = recordExplanations();
    controller.setLoadingStage('relay');

    // When the first explanation is due and has had time to type
    vi.advanceTimersByTime(MESSAGE_ROTATE_MS + TYPE_MS + 100);

    // Then it typed in a piece at a time from empty
    expect(seen).toContain('Look');
    expect(readExplanation()).toBe('Looking for other computers to talk to');
    expect(loadingState.get().explanationOpacity).toBe(1);

    // When the next turn has erased the line and typed the next one
    vi.advanceTimersByTime(MESSAGE_ROTATE_MS + ERASE_MS);

    // Then
    expect(seen).toContain('Looking for');
    expect(seen).toContain('Your');
    expect(readExplanation()).toBe('Your browser does the checking itself, not a server');
  });

  it("As a visitor, I reach a new stage mid-type and the step line swaps at once while the last stage's explanation is dropped", () => {
    // Given an explanation half typed
    const { controller } = setupController();
    controller.setLoadingStage('relay');
    vi.advanceTimersByTime(MESSAGE_ROTATE_MS + TYPE_MS / 2);
    const halfTyped = readExplanation();

    // When
    controller.setLoadingStage('resolving');

    // Then
    expect(halfTyped).not.toBe('');
    expect(readStep()).toEqual(['Found it']);
    expect(readExplanation()).toBe('');
    expect(loadingState.get().explanationOpacity).toBe(1);
    expect(loadingState.get().srText).toBe('Found it');

    // When time passes short of the next turn
    vi.advanceTimersByTime(MESSAGE_ROTATE_MS - 100);

    // Then nothing of the old stage was typed back in
    expect(readExplanation()).toBe('');
  });

  it('As a visitor who prefers reduced motion, I wait for the next explanation and it changes at once', () => {
    // Given
    const { controller } = setupController({ reducedMotion: true });
    controller.setLoadingStage('relay');

    // When
    vi.advanceTimersByTime(MESSAGE_ROTATE_MS);

    // Then
    expect(readExplanation()).toBe('Looking for other computers to talk to');
    expect(loadingState.get().srText).toBe('Looking for other computers to talk to');
  });

  it('As a visitor whose load parked, I wait out the stall time and the stall watch fires with the percentage', () => {
    // Given
    const { controller } = setupController();
    const onStall = vi.fn();
    controller.initPhases([
      {
        label: 'Fetching content',
        base: 10,
        target: 90,
        expectedMs: 10_000,
        stage: 'content',
        reportsProgress: true,
      },
    ]);
    controller.onProgressStall(onStall);

    // When
    controller.advancePhase(0);
    vi.advanceTimersByTime(PROGRESS_STALL_MS - 1);

    // Then
    expect(onStall).not.toHaveBeenCalled();

    // When
    vi.advanceTimersByTime(1);

    // Then
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall).toHaveBeenCalledWith(10);
  });

  it('As a visitor, I get a stall warning and it shows until it is cleared', () => {
    // Given
    const { controller } = setupController();

    // When
    controller.setLoadingWarning('Still looking for peers');

    // Then
    expect(loadingState.get().warning).toBe('Still looking for peers');

    // When
    controller.setLoadingWarning(null);

    // Then
    expect(loadingState.get().warning).toBeNull();
  });

  it('As a visitor whose app loaded, I watch the loading screen fill and fade and it goes after 300 ms', () => {
    // Given
    const { controller } = setupController();
    controller.initPhases([{ label: 'a', base: 0, target: 50, expectedMs: 5_000, stage: 'relay' }]);
    controller.advancePhase(0);

    // When
    controller.dismissLoading();

    // Then
    expect(loadingState.get().phase).toBe('dismissing');
    expect(readProgress()).toBe(100);

    // When
    vi.advanceTimersByTime(FADE_MS - 1);

    // Then
    expect(loadingState.get().phase).toBe('dismissing');

    // When
    vi.advanceTimersByTime(1);

    // Then
    expect(loadingState.get().phase).toBe('gone');
  });

  it('As a visitor, I see the loading screen hidden and every loading timer stops while the screen is marked gone', () => {
    // Given a crawling bar, a rotating explanation and an armed stall watch
    const { controller } = setupController();
    const onStall = vi.fn();
    controller.initPhases([{ label: 'a', base: 5, target: 90, expectedMs: 60_000, stage: 'relay' }]);
    controller.onProgressStall(onStall);
    controller.advancePhase(0);
    vi.advanceTimersByTime(1_000);

    // When
    controller.hideLoading();
    const frozen = loadingState.get();
    vi.advanceTimersByTime(MESSAGE_ROTATE_MS * 5);

    // Then
    expect(frozen.phase).toBe('gone');
    expect(loadingState.get()).toEqual(frozen);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('As a visitor, I get a late stage and a late dismiss after the loading screen was hidden and neither writes to the screen', () => {
    // Given a load whose screen has gone
    const { controller } = setupController();
    controller.initPhases(ROOT_PHASES);
    controller.advancePhase(0);
    controller.hideLoading();
    const hidden = loadingState.get();

    // When
    controller.setLoadingStage('preparing');
    controller.dismissLoading();

    // Then
    expect(loadingState.get()).toEqual(hidden);
  });

  it('As a visitor, I get late signals after the loading screen was hidden and nothing on screen changes', () => {
    // Given a load whose screen has gone
    const { controller } = setupController();
    controller.initPhases([
      { label: 'a', base: 5, target: 50, expectedMs: 60_000, stage: 'relay' },
      {
        label: 'b',
        base: 50,
        target: 90,
        expectedMs: 60_000,
        stage: 'content',
      },
    ]);
    const onStall = vi.fn();
    controller.onProgressStall(onStall);
    controller.advancePhase(0);
    controller.hideLoading();

    // When late signals arrive: content bytes, a progress fraction and a
    // phase change
    controller.setLoadingStage('preparing');
    controller.advancePhase(1);
    controller.nudgePhaseProgress(0.5, 'content');
    const afterSignals = loadingState.get();
    vi.advanceTimersByTime(MESSAGE_ROTATE_MS * 5);

    // Then time passing moves nothing: no rotation, typing frame, crawl or stall watch runs
    expect(afterSignals.phase).toBe('gone');
    expect(loadingState.get()).toEqual(afterSignals);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('As a visitor, I see a full-page screen before the load started and it takes the static screen down', () => {
    // Given a controller that has started nothing
    const { pageContent } = setupController();

    // When a full-page screen takes the page
    pageContent.set('screen');

    // Then the screen is gone
    expect(loadingState.get().phase).toBe('gone');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('As a dotli developer, I dispose the loading screen and it runs no timer and a later full-page screen leaves it up', () => {
    // Given a crawling bar, a rotating explanation and an armed stall watch
    const { controller, pageContent } = setupController();
    controller.initPhases([{ label: 'a', base: 5, target: 90, expectedMs: 60_000, stage: 'relay' }]);
    controller.advancePhase(0);
    vi.advanceTimersByTime(1_000);

    // When
    controller.dispose();
    pageContent.set('screen');

    // Then
    expect(loadingState.get().phase).toBe('active');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('As a dotli developer, I dispose the loading screen mid-fade and the fade never ends it', () => {
    // Given a screen fading out
    const { controller } = setupController();
    controller.dismissLoading();

    // When
    controller.dispose();
    vi.advanceTimersByTime(FADE_MS);

    // Then
    expect(loadingState.get().phase).toBe('dismissing');
  });

  it('As a visitor whose app loaded, I see the dismiss and the explanation rotation and the typing stop', () => {
    // Given an explanation mid-turn
    const { controller } = setupController();
    controller.initPhases([{ label: 'a', base: 5, target: 90, expectedMs: 60_000, stage: 'relay' }]);
    controller.advancePhase(0);
    vi.advanceTimersByTime(MESSAGE_ROTATE_MS + TYPE_MS / 2);
    const midTurn = readExplanation();

    // When
    controller.dismissLoading();
    vi.advanceTimersByTime(FADE_MS);

    // Then nothing is left running
    expect(loadingState.get().phase).toBe('gone');
    expect(vi.getTimerCount()).toBe(0);
    expect(midTurn).not.toBe('');

    // When more time passes
    const settled = readExplanation();
    vi.advanceTimersByTime(MESSAGE_ROTATE_MS * 3);

    // Then the line no longer changes
    expect(readExplanation()).toBe(settled);
    expect(loadingState.get().explanationOpacity).toBe(1);
  });

  it('As a visitor whose app loaded, I get a late step while the screen fades and the bar stays full with no crawl started', () => {
    // Given a screen fading out
    const { controller } = setupController();
    controller.initPhases([
      { label: 'a', base: 5, target: 50, expectedMs: 60_000, stage: 'relay' },
      { label: 'b', base: 50, target: 90, expectedMs: 60_000, stage: 'content' },
    ]);
    controller.advancePhase(0);
    controller.dismissLoading();
    const step = readStep();

    // When
    controller.advancePhase(1);

    // Then only the fade's timer runs, and the story stays where it was
    expect(readProgress()).toBe(100);
    expect(vi.getTimerCount()).toBe(1);
    expect(readStep()).toEqual(step);
  });

  it('As an operator, I see a stall listener that throws reported as a defect while the bar goes on', () => {
    // Given a counting step whose stall listener throws
    const { counted } = bindReports();
    const { controller } = setupController();
    const stalledAt: number[] = [];
    controller.initPhases(STALL_PHASES);
    controller.onProgressStall(() => {
      stalledAt.push(readShownPercent());
      throw new Error('the stall warning broke');
    });
    controller.advancePhase(1);

    // When the bar parks past the stall time, and then some
    vi.advanceTimersByTime(PROGRESS_STALL_MS + 3_000);

    // Then
    expect(counted('listener.delivery')).toEqual([expect.objectContaining({ outcome: 'error' })]);
    expect(stalledAt).toHaveLength(1);
    expect(readShownPercent()).toBeGreaterThan(nth(stalledAt, 0));
  });
});

describe('The loading bar reports when it stops moving', () => {
  it('As a user whose load is still moving, I keep getting progress and am not warned', () => {
    // Given
    const { controller } = setupController();
    const stalls: number[] = [];
    controller.initPhases(STALL_PHASES);
    controller.onProgressStall(percent => {
      stalls.push(percent);
    });
    controller.advancePhase(1);

    // When
    for (let tenth = 1; tenth <= 6; tenth += 1) {
      vi.advanceTimersByTime(1_000);
      controller.nudgePhaseProgress(tenth / 10, 'content');
    }

    // Then
    expect(stalls).toEqual([]);
  });

  it('As a user whose load recovers then parks again, I wait through both stalls and am warned each time', () => {
    // Given
    const { controller } = setupController();
    const stalls: number[] = [];
    controller.initPhases(STALL_PHASES);
    controller.onProgressStall(percent => {
      stalls.push(percent);
    });
    controller.advancePhase(1);

    // When
    vi.advanceTimersByTime(PROGRESS_STALL_MS + 100);
    controller.nudgePhaseProgress(0.5, 'content');
    vi.advanceTimersByTime(PROGRESS_STALL_MS + 100);

    // Then
    expect(stalls.length).toBe(2);
    expect(stalls[1]).toBeGreaterThan(nth(stalls, 0));
  });

  it('As a user whose stall listener was removed, I wait out a parked load and am not warned', () => {
    // Given
    const { controller } = setupController();
    const stalls: number[] = [];
    controller.initPhases(STALL_PHASES);
    const removeListener = controller.onProgressStall(percent => {
      stalls.push(percent);
    });
    controller.advancePhase(1);

    // When
    removeListener();
    vi.advanceTimersByTime(PROGRESS_STALL_MS + 100);

    // Then
    expect(stalls).toEqual([]);
  });

  it('As a user whose earlier stall listener was removed, I wait out a parked load and am warned through the one that stays', () => {
    // Given
    const { controller } = setupController();
    const stalls: number[] = [];
    controller.initPhases(STALL_PHASES);
    const removeEarlier = controller.onProgressStall(() => undefined);
    controller.onProgressStall(percent => {
      stalls.push(percent);
    });
    controller.advancePhase(1);

    // When
    removeEarlier();
    vi.advanceTimersByTime(PROGRESS_STALL_MS + 100);

    // Then
    expect(stalls.length).toBe(1);
  });
});

describe('The loading bar never stands still', () => {
  it('As a user whose download reports nothing at all, I wait a minute and the number still moves every 3 seconds', () => {
    // Given
    const { controller } = setupController();
    controller.initPhases(STALL_PHASES);
    controller.advancePhase(1);

    // When
    const seen: number[] = [readShownPercent()];
    for (let tick = 0; tick < 20; tick += 1) {
      vi.advanceTimersByTime(3_000);
      seen.push(readShownPercent());
    }

    // Then no reading repeats the one before it
    expect(seen.filter((percent, index) => index > 0 && percent === seen[index - 1])).toEqual([]);
  });

  it('As a user whose current step counts bytes, I wait long and the creeping number never claims more than the step', () => {
    // Given
    const { controller } = setupController();
    controller.initPhases(STALL_PHASES);
    controller.advancePhase(1);

    // When
    vi.advanceTimersByTime(10 * 60_000);

    // Then
    expect(readShownPercent()).toBeLessThanOrEqual(nth(STALL_PHASES, 1).target);
  });

  it('As a user whose real progress overtakes the creep, I get that progress and the number follows the truth', () => {
    // Given
    const { controller } = setupController();
    controller.initPhases(STALL_PHASES);
    controller.advancePhase(1);
    vi.advanceTimersByTime(9_000);
    const crept = readShownPercent();

    // When
    controller.nudgePhaseProgress(0.9, 'content');

    // Then
    expect(readShownPercent()).toBeGreaterThan(crept);
  });

  it('As a user whose network found its content peers before the download began, I wait through the download step and the bar crawls across it', () => {
    // Given the release heard during the step before the counting one
    const { controller } = setupController();
    controller.initPhases(STALL_PHASES);
    controller.advancePhase(0);
    controller.releasePhaseProgress();

    // When
    controller.advancePhase(1);
    vi.advanceTimersByTime(nth(STALL_PHASES, 1).expectedMs);

    // Then the crawl, not the 1% floor, carried the bar most of the way
    expect(readShownPercent()).toBeGreaterThanOrEqual(nth(STALL_PHASES, 1).target - 1);
  });
});

describe('The loading screen reports a collaborator that throws', () => {
  it('As an operator, I see a page content that throws as the screen stops following it reported as a defect while dispose returns', () => {
    // Given a page whose unsubscribe throws
    const { counted } = bindReports();
    const pageContent = atom<PageContent>('page');
    pageContent.listen = () => () => {
      throw new Error('the page cannot be unfollowed');
    };
    const { controller } = setupController({ pageContent });

    // When
    controller.dispose();

    // Then
    expect(counted('loading_screen.transition')).toEqual([expect.objectContaining({ outcome: 'error' })]);
  });

  it('As a visitor whose page content throws as the screen stops following it, I see a full-page screen still take the loading screen down', () => {
    // Given a page whose unsubscribe throws
    bindReports();
    const pageContent = atom<PageContent>('page');
    pageContent.listen = () => () => {
      throw new Error('the page cannot be unfollowed');
    };
    const { controller } = setupController({ pageContent });

    // When
    controller.hideLoading();

    // Then
    expect(loadingState.get().phase).toBe('gone');
  });

  it('As an operator, I see a page content that throws as the screen starts following it reported as a defect while the screen still shows its steps', () => {
    // Given a page that cannot be followed
    const { counted } = bindReports();
    const pageContent = atom<PageContent>('page');
    pageContent.listen = () => {
      throw new Error('the page cannot be followed');
    };

    // When
    const { controller } = setupController({ pageContent, reducedMotion: true });
    controller.setLoadingStage('relay');

    // Then
    expect(counted('loading_screen.transition')).toEqual([expect.objectContaining({ outcome: 'error' })]);
    expect(readStep()).toEqual(['Connecting to Polkadot']);
  });

  it('As an operator, I see a page interval that throws as the bar starts crawling reported as a defect', () => {
    // Given
    const { counted } = bindReports();
    const { controller } = setupController({
      collaborators: {
        poll: {
          start() {
            throw new Error('the page has no interval');
          },
        },
      },
    });
    controller.initPhases(ROOT_PHASES);

    // When
    controller.advancePhase(0);

    // Then
    expect(counted('loading_screen.transition')).toEqual([expect.objectContaining({ outcome: 'error' })]);
  });

  it('As an operator, I see animation frames that throw as an explanation starts typing reported as a defect', () => {
    // Given
    const { counted } = bindReports();
    const { controller } = setupController({
      collaborators: {
        frames: {
          request() {
            throw new Error('the page draws no frames');
          },
          cancel: () => undefined,
          now: () => performance.now(),
        },
      },
    });
    controller.setLoadingStage('relay');

    // When the first explanation is due
    vi.advanceTimersByTime(MESSAGE_ROTATE_MS);

    // Then
    expect(counted('loading_screen.transition')).toEqual([expect.objectContaining({ outcome: 'error' })]);
  });

  it('As an operator, I see page timers that throw as a stage starts its explanations reported as a defect', () => {
    // Given
    const { counted } = bindReports();
    const { controller } = setupController({
      collaborators: {
        timers: {
          now: () => Date.now(),
          setTimeout() {
            throw new Error('the page has no timers');
          },
          clearTimeout: () => undefined,
        },
      },
    });

    // When
    controller.setLoadingStage('relay');

    // Then
    expect(counted('loading_screen.transition')).toEqual([expect.objectContaining({ outcome: 'error' })]);
  });
});

describe('Restarting the loading phases', () => {
  it('As a visitor, I see the loading phases start again and the overlay stays on screen until it is hidden', () => {
    // Given
    const { controller } = setupController();
    controller.initPhases(ROOT_PHASES);

    // When
    controller.initPhases(ROOT_PHASES);

    // Then
    expect(loadingState.get().phase).toBe('active');

    // When
    controller.hideLoading();

    // Then
    expect(loadingState.get().phase).toBe('gone');
  });

  it('As a user whose loading phases start again, I wait past the stall time and am not warned about the earlier load', () => {
    // Given a counting step whose bar is watched for a stall
    const { controller } = setupController();
    const stalls: number[] = [];
    controller.initPhases(STALL_PHASES);
    controller.onProgressStall(percent => {
      stalls.push(percent);
    });
    controller.advancePhase(1);

    // When the phases start again and the stall time passes
    controller.initPhases(STALL_PHASES);
    vi.advanceTimersByTime(PROGRESS_STALL_MS + 100);

    // Then
    expect(stalls).toEqual([]);
  });
});

/** Builds a controller over fresh stores and a page of its own, torn down with the global fake timers. */
function setupController({
  reducedMotion = false,
  pageContent = atom<PageContent>('page'),
  collaborators = {},
}: Params = {}): Stand {
  // Global, not manual, timers: the minutes-long cases fire tens of thousands of 16ms typing frames, and manual timers
  // settle a real macrotask after each one.
  vi.useFakeTimers();
  resetAllStoresForTests();
  const frameTimers = new Map<number, ReturnType<typeof setTimeout>>();
  let lastFrame = 0;
  const controller = createLoadingController({
    prefersReducedMotion: () => reducedMotion,
    // A frame every 16ms on the faked clock. Node's timers are objects, so each gets a number like a frame handle.
    frames: {
      request(step) {
        const handle = ++lastFrame;
        frameTimers.set(
          handle,
          setTimeout(() => {
            frameTimers.delete(handle);
            step(performance.now());
          }, 16),
        );
        return handle;
      },
      cancel(handle) {
        clearTimeout(frameTimers.get(handle));
        frameTimers.delete(handle);
      },
      now: () => performance.now(),
    },
    pageContent,
    ...collaborators,
  });
  onTestFinished(() => {
    controller.dispose();
    vi.useRealTimers();
  });
  return {
    controller,
    pageContent,
  };
}

function readProgress(): number {
  return loadingState.get().progress;
}

function readShownPercent(): number {
  return Math.round(loadingState.get().progress);
}

function readExplanation(): string {
  return loadingState.get().explanation;
}

function readStep(): readonly StepPart[] {
  return loadingState.get().step;
}

/** Collects every distinct explanation the store holds from now on, in order, until the case ends. */
function recordExplanations(): string[] {
  const seen: string[] = [readExplanation()];
  onTestFinished(
    loadingState.store.listen(() => {
      const text = readExplanation();
      if (text !== seen[seen.length - 1]) {
        seen.push(text);
      }
    }),
  );
  return seen;
}
