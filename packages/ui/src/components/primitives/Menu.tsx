// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { omit } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './Menu.module.css';

export interface MenuProps {
  id: string;
  open: boolean;
  /** Receives the surface, for createPopover's `menu` mode. */
  ref: (el: HTMLDivElement) => void;
  label?: string;
  labelledBy?: string;
  onClick?: (ev: MouseEvent) => void;
  class?: string | undefined;
  testId?: string;
  children: JSX.Element;
}

/** Keys, focus and dismissal are createPopover's `menu` mode, which the consumer wires to the surface it receives through `ref`. */
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
  checked?: boolean;
  class?: string | undefined;
  testId?: string;
}

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
