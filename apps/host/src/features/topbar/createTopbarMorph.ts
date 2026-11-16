// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A fold or reveal morphs the bar's box every frame, so what is laid out against it is read once the morph ends.

import { createMorphCount } from './createMorphCount.js';

/** Builds the bar's morph with no bar bound, so it never runs until one is. Building it reads no browser global. */
export function createTopbarMorph() {
  const ends = new Set<() => void>();
  // The bound bar's own count of running morphs, so another bar's late release leaves it be.
  let bound: ReturnType<typeof createMorphCount> | null = null;

  function onEnd(listener: () => void): () => void {
    ends.add(listener);
    function remove(): void {
      ends.delete(listener);
    }
    return remove;
  }

  function setBar(bar: HTMLElement, onSettled: () => void): () => void {
    const morphs = createMorphCount({
      areTransitionsRunning: () => bar.getAnimations().some(animation => 'transitionProperty' in animation),
    });
    bound = morphs;
    // Children's transitions bubble up here and are not the bar's box. A bar replaced by another no longer morphs.
    function onMorphRun(event: Event): void {
      if (event.target === bar && bound === morphs) {
        morphs.start();
      }
    }
    function onMorphEnd(event: Event): void {
      if (event.target !== bar || bound !== morphs || !morphs.end()) {
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
      if (bound === morphs) {
        bound = null;
      }
    }
    bar.addEventListener('transitionrun', onMorphRun);
    bar.addEventListener('transitionend', onMorphEnd);
    bar.addEventListener('transitioncancel', onMorphEnd);
    return release;
  }

  return {
    /** Returns whether a fold or reveal still resizes the bound bar. */
    running: (): boolean => bound?.isRunning() ?? false,
    /** Calls `listener` each time the last running morph ends, after the bound bar's `onSettled`. Returns its removal. */
    onEnd,
    /**
     * Binds `bar`, whose own transitions are the morph, in place of any bar bound before, with a count of its own.
     * `onSettled` runs as the last running morph ends, before the `onEnd` listeners. Returns the release, which unbinds
     * `bar` and its count while it is still the bound one.
     */
    setBar,
  };
}

/** The page's bar morph. */
export const topbarMorph = createTopbarMorph();
