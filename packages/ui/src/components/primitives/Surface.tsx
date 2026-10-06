// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show, useContext } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { InSheet } from '../floating/in-sheet.js';
import s from './Surface.module.css';

export type SurfaceWidth = 'sm' | 'md' | 'lg' | 'xl';

/**
 * The body of a popover: its padding, gap, head and foot. The frame it sits
 * in draws the glass. In a bottom sheet the sheet's head carries the title,
 * so SurfaceHead draws none.
 */
export function Surface(props: { width?: SurfaceWidth; testId?: string; children: JSX.Element }): JSX.Element {
  const inSheet = useContext(InSheet);
  return (
    <section
      class={s['surface']}
      data-width={props.width ?? 'md'}
      data-sheet={inSheet() ? '' : undefined}
      data-testid={props.testId}
    >
      {props.children}
    </section>
  );
}

export function SurfaceHead(props: {
  title: string;
  /** A chip or caption on the right, such as the network or the app host. */
  aside?: JSX.Element;
  testId?: string;
}): JSX.Element {
  const inSheet = useContext(InSheet);
  return (
    <Show when={!inSheet()}>
      <div class={s['head']} data-testid={props.testId}>
        <h2 class={s['title']}>{props.title}</h2>
        {props.aside}
      </div>
    </Show>
  );
}

/** A hairline, then a hint on the left and the surface's action on the right. */
export function SurfaceFoot(props: { hint?: JSX.Element; children?: JSX.Element; testId?: string }): JSX.Element {
  return (
    <div class={s['foot']} data-testid={props.testId}>
      {props.hint}
      {props.children}
    </div>
  );
}

/** A caption led by a small icon, such as a reload notice. */
export function Hint(props: { icon?: JSX.Element; testId?: string; children: JSX.Element }): JSX.Element {
  return (
    <span class={s['hint']} data-testid={props.testId}>
      {props.icon}
      {props.children}
    </span>
  );
}

/** The reload notice's arrow, for a Hint. */
export function ReloadIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}
