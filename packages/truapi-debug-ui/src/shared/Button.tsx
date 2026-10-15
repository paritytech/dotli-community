// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The panel's action button, in the header, Diagnostics and Wallet.

import type { JSX } from '@solidjs/web';
import s from './Button.module.css';

export function Button(props: {
  testId?: string | undefined;
  type?: 'button' | 'submit';
  /** A glyph rather than text, so it gets narrower padding and a muted colour. */
  icon?: boolean;
  /** A toggle that is on, such as Pause while paused. */
  active?: boolean;
  /** For a button that shows or hides a region, whether it is shown. */
  expanded?: boolean | undefined;
  title?: string | undefined;
  label?: string | undefined;
  disabled?: boolean;
  hidden?: boolean;
  class?: string | undefined;
  onClick?: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      class={[s['button'], props.icon === true && s['icon'], props.class]}
      type={props.type ?? 'button'}
      data-testid={props.testId}
      data-active={props.active === true ? '' : undefined}
      aria-expanded={props.expanded === undefined ? undefined : props.expanded ? 'true' : 'false'}
      title={props.title}
      aria-label={props.label}
      disabled={props.disabled}
      hidden={props.hidden}
      onClick={() => {
        props.onClick?.();
      }}
    >
      {props.children}
    </button>
  );
}
