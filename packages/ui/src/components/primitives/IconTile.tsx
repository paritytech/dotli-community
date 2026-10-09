// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './IconTile.module.css';

/**
 * The decorative tile that leads a modal or the sign-in's pending view.
 * `markup` must be app-owned SVG from the host's own modules, never user input.
 */
export function IconTile(props: {
  markup?: string | undefined;
  class?: string | undefined;
  testId?: string | undefined;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <Show
      when={props.markup}
      fallback={
        <div class={[s['tile'], props.class]} aria-hidden="true" data-testid={props.testId}>
          {props.children}
        </div>
      }
    >
      {markup => (
        // eslint-disable-next-line solid/no-innerhtml -- trusted SVG markup from the host's own modules, never user input
        <div class={[s['tile'], props.class]} aria-hidden="true" data-testid={props.testId} innerHTML={markup()} />
      )}
    </Show>
  );
}
