// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Spinner } from './Spinner.js';
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
  /** A spinner in place of the children, and no clicks, until the button knows what it is for. */
  loading?: boolean;
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

/**
 * Grows the button from the loading circle to the width of what replaced the spinner. Only this change animates, so
 * a button resized for any other reason never morphs. The clip and the zero minimum hold for the animation only, as a
 * flex parent would otherwise keep the button at its content's width.
 */
function growFromCircle(el: HTMLButtonElement): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }
  const style = getComputedStyle(el);
  const duration = parseFloat(style.getPropertyValue('--dur')) * 1000;
  // Without the tokens' stylesheet, as in unit tests, there is nothing to time it by.
  if (!Number.isFinite(duration)) {
    return;
  }
  const { width, height } = el.getBoundingClientRect();
  el.animate(
    { width: [`${String(height)}px`, `${String(width)}px`], minWidth: ['0px', '0px'], overflow: ['clip', 'clip'] },
    { duration, easing: style.getPropertyValue('--ease-out') },
  );
}

/** A chrome button: secondary by default, primary for the one main action, danger for a reject. */
export function Button(props: ButtonProps): JSX.Element {
  let el: HTMLButtonElement | undefined;
  let wasLoading = false;
  createEffect(
    () => props.loading === true,
    loading => {
      if (wasLoading && !loading && el !== undefined) {
        growFromCircle(el);
      }
      wasLoading = loading;
    },
  );
  return (
    <button
      ref={node => {
        el = node;
        props.ref?.(node);
      }}
      type="button"
      onClick={ev => {
        props.onClick?.(ev);
      }}
      id={props.id}
      title={props.title}
      disabled={props.disabled === true || props.loading === true}
      aria-busy={props.loading === true ? 'true' : undefined}
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
      data-loading={props.loading === true ? '' : undefined}
      data-testid={props.testId}
    >
      {props.loading === true ? <Spinner class={s['spinner']} /> : props.children}
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
