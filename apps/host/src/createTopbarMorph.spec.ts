// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createTopbarMorph } from './createTopbarMorph.js';

type Params = {
  /** Whether the bar answers that its transitions still run. */
  running?: boolean;
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

  it('As a user whose bar unmounts mid-morph, I see it release and neither the morph nor its later transitions run or settle', () => {
    // Given a morph that started
    const morph = createTopbarMorph();
    const bar = createBar();
    const onSettled = vi.fn();
    const release = morph.setBar(bar, onSettled);
    runMorph(bar);

    // When the bar releases, and its transitions still fire
    release();
    const afterRelease = morph.running();
    runMorph(bar);
    const afterLaterRun = morph.running();
    endMorph(bar);

    // Then
    expect({ afterRelease, afterLaterRun, settled: onSettled.mock.calls.length }).toEqual({
      afterRelease: false,
      afterLaterRun: false,
      settled: 0,
    });
  });

  it('As a user whose bar was replaced, I ask whether the morph still runs and the new bar is the one asked', () => {
    // Given a first bar whose transitions run, rebound to a second whose transitions do not
    const morph = createTopbarMorph();
    const first = createBar();
    const second = createBar({ running: false });
    morph.setBar(first, vi.fn());
    morph.setBar(second, vi.fn());
    runMorph(second);

    // When
    const running = morph.running();

    // Then
    expect(running).toBe(false);
  });

  it("As a user whose bar was replaced, I see the first bar release late mid-morph and the new bar's morph still runs and settles", () => {
    // Given a second bar bound in place of the first, its morph running
    const morph = createTopbarMorph();
    const onSettled = vi.fn();
    const first = createBar();
    const second = createBar();
    const releaseFirst = morph.setBar(first, vi.fn());
    morph.setBar(second, onSettled);
    runMorph(second);

    // When the first bar releases, and then the morph ends
    releaseFirst();
    const running = morph.running();
    endMorph(second);

    // Then
    expect({ running, settled: onSettled.mock.calls.length }).toEqual({ running: true, settled: 1 });
  });
});

/** Builds a bar that dispatches its own transitions and answers whether they run, as the morph reads only those. */
function createBar({ running = true }: Params = {}): HTMLElement {
  const transition = { transitionProperty: 'max-width' } as CSSTransition;
  const bar = Object.assign(new EventTarget(), { getAnimations: () => (running ? [transition] : []) });
  // The morph reads only the bar's events and its animations.
  return bar as unknown as HTMLElement;
}

function runMorph(bar: HTMLElement): void {
  bar.dispatchEvent(new Event('transitionrun'));
}

function endMorph(bar: HTMLElement): void {
  bar.dispatchEvent(new Event('transitionend'));
}
