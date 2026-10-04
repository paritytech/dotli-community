// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './SectionLabel.module.css';

/**
 * A section's caps label, over the cards, wells or rows it heads. `as` picks
 * the element: a plain div by default, a heading where the label names a
 * group (`id` is what that group's aria-labelledby points at).
 */
export function SectionLabel(props: {
  text: string;
  id?: string | undefined;
  as?: 'div' | 'h3' | undefined;
  /** A class of the consumer's own, for its padding in a list. */
  class?: string | undefined;
  testId?: string | undefined;
}): JSX.Element {
  return (
    <Show
      when={props.as === 'h3'}
      fallback={
        <div class={[s['label'], props.class]} id={props.id} data-testid={props.testId}>
          {props.text}
        </div>
      }
    >
      <h3 class={[s['label'], props.class]} id={props.id} data-testid={props.testId}>
        {props.text}
      </h3>
    </Show>
  );
}
