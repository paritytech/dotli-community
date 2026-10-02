// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { omit } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './IconButton.module.css';

export interface IconButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'class'> {
  /** What the button opens is open: drawn pressed, as `data-active`. */
  active?: boolean;
  /** A dot in the corner flags a state worth a look, as `data-badge`. */
  badge?: boolean;
  /** A class of the consumer's own, for placement and visibility. */
  class?: string | undefined;
  /** Rendered as `data-testid`. */
  testId?: string;
}

/**
 * A topbar button around an icon: the account, network, chat,
 * permissions, theme, settings and More buttons. Its icon (an `<svg>`
 * child) draws at 18px.
 *
 * Every other prop (id, title, ARIA, `ref`, handlers, a Popover trigger's
 * spread) goes to the `<button>`.
 */
export function IconButton(props: IconButtonProps): JSX.Element {
  const button = omit(props, 'active', 'badge', 'class', 'testId', 'children');
  return (
    <button
      {...button}
      class={[s['button'], props.class]}
      data-active={props.active === true ? '' : undefined}
      data-badge={props.badge === true ? '' : undefined}
      data-testid={props.testId}
    >
      {props.children}
    </button>
  );
}
