// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A fold or reveal morphs the bar's box every frame, so what is laid out against it is read once the morph ends.

import { createMorphCount } from './createMorphCount.js';

export type TopbarMorph = ReturnType<typeof createTopbarMorph>;

/** Builds the bar's morph with no bar bound, so it never runs until one is. Building it reads no browser global. */
export function createTopbarMorph() {
  const ends = new Set<() => void>();
  let morphBar: HTMLElement | null = null;
  const morphs = createMorphCount({ areTransitionsRunning: areBarTransitionsRunning });

  function areBarTransitionsRunning(): boolean | undefined {
    const bar = morphBar;
    if (bar === null || typeof bar.getAnimations !== 'function') {
      return undefined;
    }
    return bar.getAnimations().some(animation => 'transitionProperty' in animation);
  }

  function onEnd(listener: () => void): () => void {
    ends.add(listener);
    function remove(): void {
      ends.delete(listener);
    }
    return remove;
  }

  function setBar(bar: HTMLElement, onSettled: () => void): () => void {
    morphBar = bar;
    // Children's transitions bubble up here and are not the bar's box.
    function onMorphRun(event: Event): void {
      if (event.target === bar) {
        morphs.start();
      }
    }
    function onMorphEnd(event: Event): void {
      if (event.target !== bar || !morphs.end()) {
        return;
      }
      onSettled();
      for (const listener of [...ends]) {
        listener();
      }
    }
    function release(): void {
      bar.removeEventListener('transitionrun', onMorphRun);
      bar.removeEventListener('transitionend', onMorphEnd);
      bar.removeEventListener('transitioncancel', onMorphEnd);
      morphs.reset();
      if (morphBar === bar) {
        morphBar = null;
      }
    }
    bar.addEventListener('transitionrun', onMorphRun);
    bar.addEventListener('transitionend', onMorphEnd);
    bar.addEventListener('transitioncancel', onMorphEnd);
    return release;
  }

  return {
    /** Returns whether a fold or reveal still resizes the bound bar. Never throws. */
    running: (): boolean => morphs.isRunning(),
    /**
     * Calls `listener` each time the last running morph ends, after the bound bar's `onSettled`. Returns its removal.
     * Never throws.
     */
    onEnd,
    /**
     * Binds `bar`, whose own transitions are the morph, in place of any bar bound before. `onSettled` runs as the last
     * running morph ends, before the `onEnd` listeners. Returns the release, which clears the count and unbinds `bar`
     * while it is still the bound one. Never throws.
     */
    setBar,
  };
}

/** The page's bar morph. */
export const topbarMorph = createTopbarMorph();
