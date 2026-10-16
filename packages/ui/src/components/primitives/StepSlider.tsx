// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For, onCleanup } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { createDrags } from '../drag.js';
import { stopAt, stopForKey } from './step-slider.js';
import s from './StepSlider.module.css';

export interface StepSliderStop {
  label: string;
  testId?: string;
}

export interface StepSliderProps {
  /** The slider's accessible name. */
  label: string;
  /** In order from the start of the track. */
  stops: readonly StepSliderStop[];
  /** The index of the stop the thumb sits on. */
  value: number;
  /** Read aloud for a stop in place of its label, such as the stop and a note on it. */
  valueText?: (index: number) => string;
  /**
   * Every commit: a pointer released over the track, a step key, Enter or Space, or a stop's label pressed. The stop
   * the slider is on is committed too, so its owner can apply it again.
   */
  onCommit: (index: number) => void;
  class?: string | undefined;
  testId?: string;
}

/** One of a few named stops on a track, committed by the gesture that ends on it. */
export function StepSlider(props: StepSliderProps): JSX.Element {
  const drags = createDrags();
  onCleanup(drags.stopAll);
  // The stop under a held pointer, shown until its release commits it or a cancel drops it.
  const [dragged, setDragged] = createSignal<number | null>(null);
  const shown = (): number => dragged() ?? props.value;
  const last = (): number => Math.max(props.stops.length - 1, 0);
  const percent = (): number => (last() > 0 ? (shown() / last()) * 100 : 0);
  // The signal shows the stop, and this holds it for the release, which may land before the signal's write applies.
  let target: number | null = null;
  let track: HTMLDivElement | undefined;

  const stopUnder = (clientX: number): number => {
    const rect = track?.getBoundingClientRect();
    return rect === undefined || rect.width === 0
      ? shown()
      : stopAt((clientX - rect.left) / rect.width, props.stops.length);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || track === undefined) {
      return;
    }
    track.focus();
    target = stopUnder(event.clientX);
    setDragged(target);
    drags.start(track, event, {
      move: moved => {
        target = stopUnder(moved.clientX);
        setDragged(target);
      },
      end: released => {
        const at = target;
        target = null;
        setDragged(null);
        if (released && at !== null) {
          props.onCommit(at);
        }
      },
    });
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const next = stopForKey(event.key, props.value, props.stops.length);
    if (next === null) {
      return;
    }
    event.preventDefault();
    props.onCommit(next);
  };

  return (
    <div class={[s['slider'], props.class]} data-testid={props.testId}>
      <div
        ref={el => {
          track = el;
        }}
        role="slider"
        tabindex="0"
        aria-label={props.label}
        aria-valuemin="0"
        aria-valuemax={last()}
        aria-valuenow={shown()}
        aria-valuetext={props.valueText?.(shown()) ?? props.stops[shown()]?.label}
        class={s['track']}
        data-dragging={dragged() === null ? undefined : ''}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      >
        <span class={s['fill']} style={{ width: `${String(percent())}%` }} />
        <span class={s['thumb']} style={{ left: `${String(percent())}%` }} />
      </div>
      <div class={s['stops']}>
        <For each={props.stops}>
          {(stop, index) => (
            <button
              type="button"
              tabindex="-1"
              class={s['stop']}
              data-current={index() === shown() ? '' : undefined}
              data-testid={stop.testId}
              onClick={() => {
                props.onCommit(index());
              }}
            >
              {stop.label}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
