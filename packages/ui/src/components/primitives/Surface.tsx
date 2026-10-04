// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext, Show, useContext } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './Surface.module.css';

export type SurfaceWidth = 'sm' | 'md' | 'lg' | 'xl';

// An accessor, so a sheet that opens or closes around the surface is seen.
const InSheet = createContext<() => boolean>(() => false);

/**
 * The glass body of a popover. In a bottom sheet (`sheet`) the sheet already
 * draws the glass and the title, so this draws neither.
 */
export function Surface(props: {
  width?: SurfaceWidth;
  sheet?: boolean;
  label?: string;
  class?: string | undefined;
  testId?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <InSheet value={() => props.sheet === true}>
      <section
        class={[s['surface'], props.class]}
        aria-label={props.label}
        data-width={props.width ?? 'md'}
        data-sheet={props.sheet === true ? '' : undefined}
        data-testid={props.testId}
      >
        {props.children}
      </section>
    </InSheet>
  );
}

export function SurfaceHead(props: {
  title: string;
  /** A chip or caption on the right, such as the network or the app host. */
  aside?: JSX.Element;
  titleId?: string;
  testId?: string;
}): JSX.Element {
  const inSheet = useContext(InSheet);
  return (
    <Show when={!inSheet()}>
      <div class={s['head']} data-testid={props.testId}>
        <h2 class={s['title']} id={props.titleId}>
          {props.title}
        </h2>
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
export function Hint(props: { icon?: JSX.Element; children: JSX.Element }): JSX.Element {
  return (
    <span class={s['hint']}>
      {props.icon}
      {props.children}
    </span>
  );
}
