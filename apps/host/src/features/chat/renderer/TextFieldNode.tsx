// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createUniqueId, onCleanup, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { modifierStyle } from './customStyles.js';
import { createEchoHold } from './echoHold.js';
import type { CustomActionHandler, KindValue } from './types.js';
import s from './TextFieldNode.module.css';

const textEncoder = new TextEncoder();

/** A product's single-line text field, which reports what the user types and keeps their caret across trees. */
export function TextFieldNode(props: { value: KindValue<'TextField'>; onAction: CustomActionHandler }): JSX.Element {
  const inputId = createUniqueId();
  let input: HTMLInputElement | undefined;
  const hold = createEchoHold({
    value: () => input?.value ?? '',
    write: text => {
      if (input !== undefined) {
        input.value = text;
      }
    },
    isFocused: () => input !== undefined && document.activeElement === input,
  });
  onCleanup(hold.dispose);

  // Shows the product's current text with nothing held or typed, as a new element would.
  const startFresh = (el: HTMLInputElement): void => {
    const text = untrack(() => props.value.props.text);
    hold.reset(text);
    el.value = text;
  };

  // Not a `value` binding, which Solid rewrites on every tree and which would move the caret.
  createEffect(
    () => props.value.props.text,
    text => {
      hold.receive(text);
    },
  );
  // Position matching hands this element another field when the product inserts or removes one above.
  // Start it fresh, as a new element would, without the other field's focus.
  createEffect(
    () => fieldIdentity(props.value),
    (identity, previous) => {
      if (input === undefined || previous === undefined || identity === previous) {
        return;
      }
      startFresh(input);
      if (document.activeElement === input) {
        input.blur();
      }
    },
  );
  return (
    <div class={s['field']} data-testid="chat-custom-field" style={modifierStyle(props.value.modifiers)}>
      <Show when={props.value.props.label !== undefined && props.value.props.label !== ''}>
        <label class={s['fieldLabel']} for={inputId}>
          {props.value.props.label}
        </label>
      </Show>
      <input
        ref={el => {
          input = el;
          startFresh(el);
        }}
        id={inputId}
        type="text"
        class={s['fieldInput']}
        placeholder={props.value.props.placeholder}
        disabled={props.value.props.enabled === false}
        onInput={event => {
          hold.typed();
          const action = props.value.props.valueChangeAction;
          if (action !== undefined) {
            props.onAction(action, textEncoder.encode(event.currentTarget.value));
          }
        }}
      />
    </div>
  );
}

/** What makes a text field the same field from one tree to the next. */
function fieldIdentity(value: KindValue<'TextField'>): string {
  return `${value.props.valueChangeAction ?? ''}\u0000${value.props.label ?? ''}`;
}
