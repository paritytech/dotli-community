// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onCleanup, onSettled, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { animateMoodRing, moodAge, MOOD_PALETTE } from '../../profile/mood-ring.js';
import type { Mood } from '../../profile/profile-record.js';

export function MoodRing(props: { mood: Mood; size: number; animated?: boolean }): JSX.Element {
  const [fallback, setFallback] = createSignal(props.animated !== true);
  let canvas: HTMLCanvasElement | undefined;
  let stop: (() => void) | null = null;
  onSettled(() => {
    if (canvas !== undefined && props.animated === true) {
      stop = animateMoodRing(canvas, props.mood, props.size);
      setFallback(stop === null);
    }
  });
  onCleanup(() => stop?.());
  const palette = () => MOOD_PALETTE[props.mood.kind];
  return (
    <div
      class={['profile-mood-ring', { 'profile-mood-ring-static': fallback() }]}
      aria-hidden="true"
      style={{
        width: `${String(Math.round(props.size * 1.5))}px`,
        height: `${String(Math.round(props.size * 1.5))}px`,
        '--ring-a': palette().a,
        '--ring-b': palette().b,
        '--ring-c': palette().c,
        opacity: fallback() ? String(1 - 0.62 * moodAge(props.mood)) : undefined,
      }}
    >
      <Show when={props.animated === true && !fallback()}>
        <canvas
          ref={el => {
            canvas = el;
          }}
        />
      </Show>
    </div>
  );
}
