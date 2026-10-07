// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './Button.module.css';

export type ButtonVariant = 'secondary' | 'primary' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

// Explicit props, not a rest spread: splitting the rest off pulls Solid's `omit` into the boot bundle.
export interface ButtonProps {
  ref?: (el: HTMLButtonElement) => void;
  onClick?: (ev: MouseEvent) => void;
  id?: string;
  title?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full width of its container. */
  block?: boolean;
  disabled?: boolean;
  'aria-label'?: string | undefined;
  'aria-expanded'?: 'true' | 'false' | undefined;
  'aria-controls'?: string | undefined;
  'aria-haspopup'?: 'dialog' | 'menu' | undefined;
  popovertarget?: string | undefined;
  style?: JSX.CSSProperties | undefined;
  class?: string | undefined;
  testId?: string;
  children?: JSX.Element;
}

/** A chrome button: secondary by default, primary for the one main action, danger for a reject. */
export function Button(props: ButtonProps): JSX.Element {
  return (
    <button
      ref={props.ref}
      type="button"
      onClick={ev => {
        props.onClick?.(ev);
      }}
      id={props.id}
      title={props.title}
      disabled={props.disabled}
      aria-label={props['aria-label']}
      aria-expanded={props['aria-expanded']}
      aria-controls={props['aria-controls']}
      aria-haspopup={props['aria-haspopup']}
      popovertarget={props.popovertarget}
      style={props.style}
      class={[s['button'], props.class]}
      data-variant={props.variant ?? 'secondary'}
      data-size={props.size ?? 'md'}
      data-block={props.block === true ? '' : undefined}
      data-testid={props.testId}
    >
      {props.children}
    </button>
  );
}

export interface ButtonLinkProps {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full width of its container. */
  block?: boolean;
  class?: string | undefined;
  testId?: string;
  children?: JSX.Element;
}

/** A link drawn as a Button, for an action that navigates. Keep its attributes in step with Button. */
export function ButtonLink(props: ButtonLinkProps): JSX.Element {
  return (
    <a
      href={props.href}
      class={[s['button'], props.class]}
      data-variant={props.variant ?? 'secondary'}
      data-size={props.size ?? 'md'}
      data-block={props.block === true ? '' : undefined}
      data-testid={props.testId}
    >
      {props.children}
    </a>
  );
}
