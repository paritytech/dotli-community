// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo, type Component } from 'solid-js';
import { dynamic, type JSX } from '@solidjs/web';
import type { IconProps } from '@dotli/ui/icons';
import type { ChainMark } from './chainHealth.js';
import s from './ChainHealthMark.module.css';

const RING_RADIUS = 12.5;

const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** A ring of radius 12.2 with ten waves of 0.9, as the mobile app draws a chain still connecting. */
const SCALLOP =
  'M27.10 14.00L26.96 14.68L26.58 15.32L26.05 15.91L25.49 16.44L25.03 16.96L24.75 17.49L24.66 18.09L24.73 18.78L24.87 19.54L24.96 20.32L24.89 21.07L24.60 21.70L24.09 22.17L23.40 22.46L22.63 22.63L21.86 22.73L21.19 22.88L20.64 23.14L20.22 23.58L19.88 24.18L19.54 24.87L19.15 25.56L18.65 26.12L18.05 26.46L17.36 26.54L16.63 26.37L15.91 26.05L15.23 25.69L14.60 25.40L14.00 25.30L13.40 25.40L12.77 25.69L12.09 26.05L11.37 26.37L10.64 26.54L9.95 26.46L9.35 26.12L8.85 25.56L8.46 24.87L8.13 24.18L7.78 23.58L7.36 23.14L6.81 22.88L6.14 22.73L5.37 22.63L4.60 22.46L3.91 22.17L3.40 21.70L3.11 21.07L3.04 20.32L3.13 19.54L3.27 18.78L3.34 18.09L3.25 17.49L2.97 16.96L2.51 16.44L1.95 15.91L1.42 15.32L1.04 14.68L0.90 14.00L1.04 13.32L1.42 12.68L1.95 12.09L2.51 11.56L2.97 11.04L3.25 10.51L3.34 9.91L3.27 9.22L3.13 8.46L3.04 7.67L3.11 6.93L3.40 6.30L3.91 5.83L4.60 5.54L5.37 5.37L6.14 5.27L6.81 5.12L7.36 4.86L7.78 4.42L8.12 3.82L8.46 3.13L8.85 2.44L9.35 1.88L9.95 1.54L10.64 1.46L11.37 1.63L12.09 1.95L12.77 2.31L13.40 2.60L14.00 2.70L14.60 2.60L15.23 2.31L15.91 1.95L16.63 1.63L17.36 1.46L18.05 1.54L18.65 1.88L19.15 2.44L19.54 3.13L19.88 3.82L20.22 4.42L20.64 4.86L21.19 5.12L21.86 5.27L22.63 5.37L23.40 5.54L24.09 5.83L24.60 6.30L24.89 6.93L24.96 7.67L24.87 8.46L24.73 9.22L24.66 9.91L24.75 10.51L25.03 11.04L25.49 11.56L26.05 12.09L26.58 12.68L26.96 13.32Z';

/**
 * A chain's glyph inside the mobile app's health mark: a disc when healthy, an arc at the share when short, an open ring
 * with a cross when no block arrives, and rings for the states with nothing to measure. Hidden from assistive
 * technology, so the caller says the state in words.
 */
export function ChainHealthMark(props: { mark: ChainMark; glyph: Component<IconProps> }): JSX.Element {
  const Glyph = dynamic(() => props.glyph);
  // The row re-describes its chain every tick, so the frame is redrawn only when what it draws changes.
  const frame = createMemo(() => props.mark, { equals: sameMark });
  return (
    <svg
      class={s['mark']}
      data-testid="chains-mark"
      data-kind={props.mark.kind}
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
    >
      {drawFrame(frame())}
      <g transform="translate(8 8)">
        <Glyph class={s['glyph']} size={12} />
      </g>
    </svg>
  );
}

function sameMark(a: ChainMark, b: ChainMark): boolean {
  return a.kind === b.kind && (a.kind !== 'short' || (b.kind === 'short' && a.share === b.share && a.band === b.band));
}

function drawFrame(mark: ChainMark): JSX.Element {
  switch (mark.kind) {
    case 'healthy':
      return <circle class={s['disc']} cx="14" cy="14" r="14" />;
    case 'short':
      return (
        <>
          <circle class={s['track']} cx="14" cy="14" r={RING_RADIUS} stroke-width="2" />
          {/* Mirrored, so the arc fills counterclockwise from the top. */}
          <circle
            class={s['arc']}
            data-band={mark.band}
            cx="14"
            cy="14"
            r={RING_RADIUS}
            stroke-width="2"
            stroke-linecap="round"
            stroke-dasharray={`${String(mark.share * RING_LENGTH)} ${String(RING_LENGTH)}`}
            transform="translate(28 0) scale(-1 1) rotate(-90 14 14)"
          />
        </>
      );
    case 'outage':
      return (
        <>
          {/* Three quarters clockwise from the top, so the gap is the upper-left quarter. */}
          <circle
            class={s['ring']}
            cx="14"
            cy="14"
            r={RING_RADIUS}
            stroke-width="2"
            stroke-linecap="round"
            stroke-dasharray={`${String(0.75 * RING_LENGTH)} ${String(RING_LENGTH)}`}
            transform="rotate(-90 14 14)"
          />
          <path class={s['cross']} d="M3.7 3.7L6.7 6.7M6.7 3.7L3.7 6.7" stroke-width="1.6" stroke-linecap="round" />
        </>
      );
    case 'connecting':
      return <path class={s['ring']} d={SCALLOP} stroke-width="1.5" />;
    case 'unavailable':
      // A dash of zero length with round caps draws a dot, so the ring reads as 24 dots.
      return (
        <circle
          class={s['ring']}
          cx="14"
          cy="14"
          r={RING_RADIUS}
          stroke-width="2"
          stroke-linecap="round"
          stroke-dasharray={`0 ${String(RING_LENGTH / 24)}`}
        />
      );
    case 'unused':
      return <circle class={s['track']} cx="14" cy="14" r={RING_RADIUS} stroke-width="1" />;
  }
}
