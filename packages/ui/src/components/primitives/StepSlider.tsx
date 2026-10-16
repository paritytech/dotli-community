// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For, onCleanup } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { createDrags } from '../drag.js';
import { handlesKey, stopAt, stopForKey } from './step-slider.js';
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
   * Every commit: a pointer released over the track, a stop's label pressed, Enter or Space, which commit the stop the
   * slider is on too, so its owner can apply it again, or a step key, which commits only a step.
   */
  onCommit: (index: number) => void;
  /** The value is a stop only approximately, so the thumb shows hollow. Exposed as `data-marked` on the track. */
  marked?: boolean;
  class?: string | undefined;
  testId?: string;
}

/** One of a few named stops on a track, committed by the pointer release, label press or key that picks it. */
export function StepSlider(props: StepSliderProps): JSX.Element {
  const drags = createDrags();
  onCleanup(drags.stopAll);
  // The stop under a held pointer, shown until its release commits it or a cancel drops it.
  const [dragged, setDragged] = createSignal<number | null>(null);
  // Where a held pointer is along the stops, 0 to 1. It places the thumb only, the stop it would commit is `dragged`.
  const [pointerAt, setPointerAt] = createSignal<number | null>(null);
  const shown = (): number => dragged() ?? props.value;
  const last = (): number => Math.max(props.stops.length - 1, 0);
  const stopPercent = (): number => (last() > 0 ? (shown() / last()) * 100 : 0);
  const percent = (): number => {
    const at = pointerAt();
    return at === null ? stopPercent() : at * 100;
  };
  // The signal shows the stop, and this holds it for the release, which may land before the signal's write applies.
  let target: number | null = null;
  let track: HTMLDivElement | undefined;
  let layer: HTMLDivElement | undefined;

  /** Moves the held thumb under the pointer and picks the stop nearest to it. */
  const follow = (clientX: number): void => {
    const rect = layer?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) {
      target = shown();
    } else {
      const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      target = stopAt(fraction, props.stops.length);
      setPointerAt(fraction);
    }
    setDragged(target);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || track === undefined) {
      return;
    }
    track.focus();
    follow(event.clientX);
    drags.start(track, event, {
      move: moved => {
        follow(moved.clientX);
      },
      end: released => {
        const at = target;
        target = null;
        setDragged(null);
        setPointerAt(null);
        if (released && at !== null) {
          props.onCommit(at);
        }
      },
    });
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!handlesKey(event.key)) {
      return;
    }
    event.preventDefault();
    const next = stopForKey(event.key, props.value, props.stops.length);
    if (next !== null) {
      props.onCommit(next);
    }
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
        data-marked={props.marked === true ? '' : undefined}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      >
        <span class={s['rail']} />
        <div
          ref={el => {
            layer = el;
          }}
          class={s['layer']}
        >
          <span class={s['fill']} style={{ width: `calc(${String(percent())}% + var(--fill-lead))` }} />
          <For each={props.stops}>
            {(_stop, index) => (
              <span
                class={s['tick']}
                style={{ left: `${String(last() > 0 ? (index() / last()) * 100 : 0)}%` }}
                data-filled={(last() > 0 ? (index() / last()) * 100 : 0) <= percent() ? '' : undefined}
              />
            )}
          </For>
          <span class={s['thumb']} data-testid="step-slider-thumb" style={{ left: `${String(percent())}%` }} />
        </div>
      </div>
      <div class={s['stops']}>
        <For each={props.stops}>
          {(stop, index) => (
            <button
              type="button"
              tabindex="-1"
              class={s['stop']}
              style={{ left: `${String(last() > 0 ? (index() / last()) * 100 : 0)}%` }}
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
