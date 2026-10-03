// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { omit } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './IconButton.module.css';

export interface IconButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'class'> {
  active?: boolean;
  badge?: boolean;
  class?: string | undefined;
  testId?: string;
}

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
