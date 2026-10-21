// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { StatusTone } from '../../page/status-tone.js';
import s from './IconButton.module.css';

// Explicit props, not a rest spread: splitting the rest off pulls Solid's `omit` into the boot bundle.
export interface IconButtonProps {
  ref?: (el: HTMLButtonElement) => void;
  onClick?: (ev: MouseEvent) => void;
  id?: string;
  title?: string;
  hidden?: boolean;
  'aria-label'?: string;
  'aria-haspopup'?: 'dialog' | 'menu' | undefined;
  'aria-expanded'?: 'true' | 'false';
  'aria-controls'?: string;
  popovertarget?: string | undefined;
  style?: JSX.CSSProperties | undefined;
  badge?: boolean;
  /** The badge's colour, white without one. */
  badgeTone?: StatusTone;
  /** A small round button on a fill, such as a toast's close. */
  size?: 'sm';
  class?: string | undefined;
  testId?: string;
  children?: JSX.Element;
}

export function IconButton(props: IconButtonProps): JSX.Element {
  return (
    <button
      ref={props.ref}
      type="button"
      onClick={ev => {
        props.onClick?.(ev);
      }}
      id={props.id}
      title={props.title}
      hidden={props.hidden}
      aria-label={props['aria-label']}
      aria-haspopup={props['aria-haspopup']}
      aria-expanded={props['aria-expanded']}
      aria-controls={props['aria-controls']}
      popovertarget={props.popovertarget}
      style={props.style}
      class={[s['button'], props.class]}
      data-badge={props.badge === true ? '' : undefined}
      data-tone={props.badgeTone}
      data-size={props.size}
      data-testid={props.testId}
    >
      {props.children}
    </button>
  );
}
