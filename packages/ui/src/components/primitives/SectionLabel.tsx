// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Match, Switch } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './SectionLabel.module.css';

/** A section's caps label, a heading where it names a group whose aria-labelledby points at `id`. */
export function SectionLabel(props: {
  text: string;
  id?: string | undefined;
  as?: 'div' | 'h2' | 'h3' | undefined;
  class?: string | undefined;
  testId?: string | undefined;
}): JSX.Element {
  return (
    <Switch
      fallback={
        <div class={[s['label'], props.class]} id={props.id} data-testid={props.testId}>
          {props.text}
        </div>
      }
    >
      <Match when={props.as === 'h2'}>
        <h2 class={[s['label'], props.class]} id={props.id} data-testid={props.testId}>
          {props.text}
        </h2>
      </Match>
      <Match when={props.as === 'h3'}>
        <h3 class={[s['label'], props.class]} id={props.id} data-testid={props.testId}>
          {props.text}
        </h3>
      </Match>
    </Switch>
  );
}

/** A section's label over its wells, rows or choices. */
export function Stack(props: {
  role?: 'group' | 'radiogroup' | undefined;
  'aria-label'?: string | undefined;
  'aria-labelledby'?: string | undefined;
  class?: string | undefined;
  testId?: string | undefined;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div
      class={[s['stack'], props.class]}
      role={props.role}
      aria-label={props['aria-label']}
      aria-labelledby={props['aria-labelledby']}
      data-testid={props.testId}
    >
      {props.children}
    </div>
  );
}
