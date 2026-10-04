// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './Choice.module.css';

export interface ChoiceRadio {
  name: string;
  value: string;
  disabled?: boolean;
  onChoose: () => void;
}

export interface ChoiceProps {
  title: string;
  description: string;
  /** Ringed. With `radio`, also the checked radio. */
  selected: boolean;
  /** Beside the title, such as "Recommended" or "This site". */
  chip?: JSX.Element;
  /** A leading glyph for a static card. */
  icon?: JSX.Element;
  /** Makes the card a native radio, so arrow keys move within `name`. */
  radio?: ChoiceRadio;
  class?: string | undefined;
  testId?: string;
}

function Body(props: { title: string; description: string; chip?: JSX.Element }): JSX.Element {
  return (
    <span class={s['body']}>
      <span class={s['title']}>
        {props.title}
        {props.chip}
      </span>
      <span class={s['description']}>{props.description}</span>
    </span>
  );
}

/** A selectable card: a title, a caption, and a ring when selected. */
export function Choice(props: ChoiceProps): JSX.Element {
  return (
    <Show
      when={props.radio}
      fallback={
        <div
          class={[s['choice'], props.class]}
          data-selected={props.selected ? '' : undefined}
          data-testid={props.testId}
        >
          {props.icon}
          <Body title={props.title} description={props.description} chip={props.chip} />
        </div>
      }
    >
      {radio => (
        <label
          class={[s['choice'], props.class]}
          data-selected={props.selected ? '' : undefined}
          data-disabled={radio().disabled === true ? '' : undefined}
          data-testid={props.testId}
        >
          <input
            type="radio"
            class={s['input']}
            name={radio().name}
            value={radio().value}
            checked={props.selected}
            disabled={radio().disabled}
            onChange={ev => {
              // The owner decides: the radio shows `selected` until it changes.
              ev.currentTarget.checked = props.selected;
              radio().onChoose();
              ev.currentTarget.focus();
            }}
          />
          <span class={s['radio']} aria-hidden="true" />
          <Body title={props.title} description={props.description} chip={props.chip} />
        </label>
      )}
    </Show>
  );
}
