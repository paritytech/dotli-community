// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { omit } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './Menu.module.css';

export interface MenuProps {
  /** The surface's id, which its trigger's `aria-controls` names. */
  id: string;
  /** Whether it shows, as `data-open`. */
  open: boolean;
  /** Receives the surface, for createPopover's `menu` mode. */
  ref: (el: HTMLDivElement) => void;
  /** The menu's accessible name. */
  label?: string;
  /** The id of the element that names it, in place of `label`. */
  labelledBy?: string;
  onClick?: (ev: MouseEvent) => void;
  /** A class of the consumer's own, for its width. */
  class?: string | undefined;
  /** Rendered as `data-testid`. */
  testId?: string;
  children: JSX.Element;
}

/**
 * A topbar dropdown menu (`role="menu"`): under the topbar at its right
 * edge, fading and scaling in while `open`. Its rows are MenuRows. Keys,
 * focus and dismissal are createPopover's `menu` mode, which the consumer
 * wires to the surface it receives through `ref`.
 */
export function Menu(props: MenuProps): JSX.Element {
  return (
    <div
      ref={el => {
        props.ref(el);
      }}
      onClick={ev => props.onClick?.(ev)}
      class={[s['menu'], props.class]}
      id={props.id}
      role="menu"
      aria-label={props.label}
      aria-labelledby={props.labelledBy}
      tabindex="-1"
      data-open={props.open ? '' : undefined}
      data-testid={props.testId}
    >
      {props.children}
    </div>
  );
}

export interface MenuRowProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'class' | 'role'> {
  /** `menuitemradio` for one of a set of choices, with `checked`. */
  role?: 'menuitem' | 'menuitemradio';
  /** A choice's `aria-checked`. */
  checked?: boolean;
  /** A class of the consumer's own. */
  class?: string | undefined;
  /** Rendered as `data-testid`. */
  testId?: string;
}

/**
 * A row of a Menu: an icon and a label, taking roving focus as the menu
 * moves it (`tabindex="-1"`). Every other prop (handlers, `data-*`) goes to
 * the `<button>`.
 */
export function MenuRow(props: MenuRowProps): JSX.Element {
  const row = omit(props, 'role', 'checked', 'class', 'testId', 'children');
  return (
    <button
      {...row}
      class={[s['row'], props.class]}
      role={props.role ?? 'menuitem'}
      aria-checked={props.role === 'menuitemradio' ? (props.checked === true ? 'true' : 'false') : undefined}
      tabindex="-1"
      data-testid={props.testId}
    >
      {props.children}
    </button>
  );
}
