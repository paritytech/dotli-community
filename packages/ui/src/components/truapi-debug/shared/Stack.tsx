// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './Stack.module.css';

/** Children one under another, each as wide as its content unless `stretch`. With `onSubmit` it is the form. */
export function Stack(props: {
  /** `sm` between the parts of one thing, `md` between things. */
  gap?: 'sm' | 'md';
  /** As wide as a form, rather than the whole pane. */
  narrow?: boolean;
  /** Every child as wide as the stack, such as blocks of text and code. */
  stretch?: boolean;
  onSubmit?: (event: SubmitEvent) => void;
  children: JSX.Element;
}): JSX.Element {
  const classes = (): (string | false | undefined)[] => [
    s['stack'],
    s[props.gap ?? 'sm'],
    props.narrow === true && s['narrow'],
    props.stretch === true && s['stretch'],
  ];
  return (
    <Show when={props.onSubmit} fallback={<div class={classes()}>{props.children}</div>}>
      {submit => (
        <form class={classes()} onSubmit={submit()}>
          {props.children}
        </form>
      )}
    </Show>
  );
}
