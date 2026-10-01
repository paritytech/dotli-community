// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, createSignal, onSettled, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { animateMoodRing, moodAge, MOOD_PALETTE } from '../../profile/mood-ring.js';
import type { Mood } from '../../profile/profile-record.js';

interface Animation {
  mood: Mood;
  size: number;
}

function AnimatedMoodRing(props: { animation: Animation; onFallback: (fallback: boolean) => void }): JSX.Element {
  let canvas!: HTMLCanvasElement;
  onSettled(() => {
    // The keyed animation owns this canvas and is replaced when mood or size changes.
    const { animation, onFallback } = untrack(() => ({
      animation: props.animation,
      onFallback: props.onFallback,
    }));
    const stop = animateMoodRing(canvas, animation.mood, animation.size);
    onFallback(stop === null);
    return stop ?? undefined;
  });
  return (
    <canvas
      ref={el => {
        canvas = el;
      }}
    />
  );
}

export function MoodRing(props: { mood: Mood; size: number; animated?: boolean }): JSX.Element {
  const [fallback, setFallback] = createSignal(false);
  const animation = createMemo(() => (props.animated === true ? { mood: props.mood, size: props.size } : undefined));
  const palette = createMemo(() => MOOD_PALETTE[props.mood.kind]);
  const staticRing = createMemo(() => props.animated !== true || fallback());
  return (
    <div
      class={['profile-mood-ring', { 'profile-mood-ring-static': staticRing() }]}
      aria-hidden="true"
      style={{
        width: `${String(Math.round(props.size * 1.5))}px`,
        height: `${String(Math.round(props.size * 1.5))}px`,
        '--ring-a': palette().a,
        '--ring-b': palette().b,
        '--ring-c': palette().c,
        opacity: staticRing() ? String(1 - 0.62 * moodAge(props.mood)) : undefined,
      }}
    >
      <Show when={animation()} keyed>
        {value => <AnimatedMoodRing animation={value} onFallback={setFallback} />}
      </Show>
    </div>
  );
}
