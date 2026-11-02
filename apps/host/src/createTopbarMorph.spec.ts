// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createTopbarMorph } from './createTopbarMorph.js';

type Params = {
  /** What the bar answers when asked which of its animations run. Absent, the engine cannot say. */
  getAnimations?: () => Animation[];
};

describe('createTopbarMorph', () => {
  it('As a user opening a menu against the bar, I wait out two morphs and the menu hears only the last end, after the bar settles', () => {
    // Given two overlapping morphs of the bound bar
    const morph = createTopbarMorph();
    const bar = createBar();
    const calls: string[] = [];
    morph.setBar(bar, () => calls.push('settled'));
    morph.onEnd(() => calls.push('end'));
    runMorph(bar);
    runMorph(bar);

    // When both end
    endMorph(bar);
    const afterFirstEnd = [...calls];
    endMorph(bar);

    // Then
    expect({ afterFirstEnd, calls }).toEqual({ afterFirstEnd: [], calls: ['settled', 'end'] });
  });

  it('As a user opening a menu against the bar, I watch two morphs and the morph runs from the first start to the last end', () => {
    // Given a bound bar
    const morph = createTopbarMorph();
    const bar = createBar();
    morph.setBar(bar, vi.fn());

    // When two morphs start and end
    runMorph(bar);
    runMorph(bar);
    const afterRuns = morph.running();
    endMorph(bar);
    const afterFirstEnd = morph.running();
    endMorph(bar);
    const afterLastEnd = morph.running();

    // Then
    expect([afterRuns, afterFirstEnd, afterLastEnd]).toEqual([true, true, false]);
  });

  it('As a user closing a menu, I stop its listening and it is not called when the morph ends', () => {
    // Given a listener on a running morph
    const morph = createTopbarMorph();
    const bar = createBar();
    const listener = vi.fn();
    morph.setBar(bar, vi.fn());
    const remove = morph.onEnd(listener);
    runMorph(bar);

    // When the listener is removed, and the morph ends
    remove();
    endMorph(bar);

    // Then
    expect(listener).not.toHaveBeenCalled();
  });

  it('As a user whose bar unmounts mid-morph, I see it release and the morph no longer runs', () => {
    // Given a morph that started
    const morph = createTopbarMorph();
    const bar = createBar();
    const release = morph.setBar(bar, vi.fn());
    runMorph(bar);

    // When
    release();

    // Then
    expect(morph.running()).toBe(false);
  });

  it('As a user whose bar unmounted, I see its later transitions and they neither run the morph nor settle it', () => {
    // Given a released bar
    const morph = createTopbarMorph();
    const bar = createBar();
    const onSettled = vi.fn();
    const release = morph.setBar(bar, onSettled);
    release();

    // When its transitions still fire
    runMorph(bar);
    const running = morph.running();
    endMorph(bar);

    // Then
    expect({ running, settled: onSettled.mock.calls.length }).toEqual({ running: false, settled: 0 });
  });

  it('As a user whose bar was replaced, I ask whether the morph still runs and the new bar is the one asked', () => {
    // Given a first bar whose engine cannot say, rebound to a second whose engine says none run
    const morph = createTopbarMorph();
    const first = createBar();
    const second = createBar({ getAnimations: () => [] });
    morph.setBar(first, vi.fn());
    morph.setBar(second, vi.fn());
    runMorph(second);

    // When
    const running = morph.running();

    // Then
    expect(running).toBe(false);
  });

  it('As a user whose bar was replaced, I see the first bar release late and the new bar stays bound', () => {
    // Given a first bar whose engine cannot say, rebound to a second whose engine says none run
    const morph = createTopbarMorph();
    const first = createBar();
    const second = createBar({ getAnimations: () => [] });
    const releaseFirst = morph.setBar(first, vi.fn());
    morph.setBar(second, vi.fn());
    releaseFirst();
    runMorph(second);

    // When
    const running = morph.running();

    // Then
    expect(running).toBe(false);
  });
});

/** Builds a bar that only dispatches its own transitions, as the morph listens for them. */
function createBar({ getAnimations }: Params = {}): HTMLElement {
  const bar = new EventTarget();
  // The morph reads only the bar's events and, where present, its animations.
  return (getAnimations === undefined ? bar : Object.assign(bar, { getAnimations })) as HTMLElement;
}

function runMorph(bar: HTMLElement): void {
  bar.dispatchEvent(new Event('transitionrun'));
}

function endMorph(bar: HTMLElement): void {
  bar.dispatchEvent(new Event('transitionend'));
}
