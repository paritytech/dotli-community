// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show, useContext, type Component } from 'solid-js';
import { Portal, type JSX } from '@solidjs/web';
import { DrawIcon } from '../icons/DrawIcon.js';
import type { IconProps } from '../icons/iconProps.js';
import { InSheet } from '../floating/inSheet.js';
import s from './Surface.module.css';

export type SurfaceWidth = 'sm' | 'md' | 'lg' | 'xl';

/**
 * The body of a popover. With `padded` it takes a panel's padding, which grows on a phone and changes in a bottom
 * sheet. Without it the consumer pads it through `class`. The frame draws the glass.
 * In a bottom sheet the sheet's head carries the title, and SurfaceHead puts its aside in that head's row.
 */
export function Surface(props: {
  width?: SurfaceWidth;
  /** A popover panel's padding. */
  padded?: boolean | undefined;
  class?: string | undefined;
  testId?: string;
  children: JSX.Element;
}): JSX.Element {
  const inSheet = useContext(InSheet);
  return (
    <section
      class={[s['surface'], props.class]}
      data-width={props.width ?? 'md'}
      data-padded={props.padded === true ? '' : undefined}
      data-sheet={inSheet() === undefined ? undefined : ''}
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
  // `in`, not a read, which would build the aside a second time.
  return (
    <Show
      when={'aside' in props && inSheet()?.aside}
      fallback={
        <Show when={inSheet() === undefined || 'aside' in props}>
          <div class={s['head']} data-testid={props.testId}>
            <Show when={inSheet() === undefined}>
              <h2 class={s['title']}>{props.title}</h2>
            </Show>
            {props.aside}
          </div>
        </Show>
      }
    >
      {slot => <Portal mount={slot()}>{props.aside}</Portal>}
    </Show>
  );
}

/**
 * A hairline, then a hint on the left and the surface's action on the right. In a sheet the action runs full width
 * under the hint.
 */
export function SurfaceFoot(props: { hint?: JSX.Element; children?: JSX.Element; testId?: string }): JSX.Element {
  return (
    <div class={s['foot']} data-testid={props.testId}>
      {props.hint}
      {props.children}
    </div>
  );
}

/** A caption led by a small icon, such as a reload notice. */
export function Hint(props: {
  icon?: Component<IconProps> | undefined;
  testId?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <span class={s['hint']} data-testid={props.testId}>
      <Show when={props.icon}>{icon => <DrawIcon icon={icon()} class={s['hintIcon']} />}</Show>
      {props.children}
    </span>
  );
}
