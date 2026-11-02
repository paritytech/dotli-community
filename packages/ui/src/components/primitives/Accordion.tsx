// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { ChevronDownIcon } from '../icons/ChevronDownIcon.js';
import s from './Accordion.module.css';

export type AccordionProps = {
  /** The header's text. A chevron follows it. */
  title: string;
  /**
   * Set, the owner holds the state: a press on the header only reports the next state through `onToggle`, and the
   * section shows `open` until its owner updates it. Unset, the browser opens and closes it.
   */
  open?: boolean | undefined;
  /** Called with the state the section is going to, or has gone to when the browser toggled it. */
  onToggle?: ((open: boolean) => void) | undefined;
  class?: string | undefined;
  testId?: string | undefined;
  summaryTestId?: string | undefined;
  children: JSX.Element;
};

/** A section that folds its body away under a header, on the native disclosure element. */
export function Accordion(props: AccordionProps): JSX.Element {
  const controlled = (): boolean => props.open !== undefined;
  let details: HTMLDetailsElement | undefined;
  return (
    <details
      ref={el => {
        details = el;
      }}
      class={[s['accordion'], props.class]}
      open={props.open}
      onToggle={event => {
        const open = event.currentTarget.open;
        // A controlled section reported its header's press already. Only the browser opening it on its own, as for a
        // find in the page, is news to its owner.
        if (!controlled() || open !== props.open) {
          props.onToggle?.(open);
        }
      }}
      data-testid={props.testId}
    >
      <summary
        class={s['summary']}
        onClick={event => {
          if (controlled() && details !== undefined) {
            event.preventDefault();
            const next = !details.open;
            // The owner holds the state asked for only when it refused a toggle the browser made, so the element
            // catches up itself.
            if (next === props.open) {
              details.open = next;
            }
            props.onToggle?.(next);
          }
        }}
        data-testid={props.summaryTestId}
      >
        {props.title}
        <ChevronDownIcon class={s['chevron']} />
      </summary>
      <div class={s['body']}>{props.children}</div>
    </details>
  );
}
