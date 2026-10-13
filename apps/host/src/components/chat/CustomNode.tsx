// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Product strings land as JSX text and every style comes from the closed mapping in custom-styles.ts.
// Nodes match by tag and children by position, so an updated tree keeps a focused field's caret and text.

import { createEffect, createUniqueId, For, Match, onCleanup, Show, Switch, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { RendererNode } from '@parity/truapi';
import { InlineActionButton, type InlineActionButtonVariant } from './InlineActionButton.js';
import { boxStyle, columnStyle, modifierStyle, rowStyle, textStyle } from './custom-styles.js';
import { createEchoHold } from './echo-hold.js';
import s from './CustomNode.module.css';

/** Reports a user gesture inside a rendered tree back to the product. */
export type CustomActionHandler = (actionId: string, payload?: Uint8Array) => void;

type NodeTag = Exclude<RendererNode['tag'], 'Nil'>;
type NodeValues = {
  [N in RendererNode as N['tag']]: N extends { value: infer V } ? V : never;
};
type NodeValue<T extends NodeTag> = NodeValues[T];

const textEncoder = new TextEncoder();

/** `node`'s value when it is a `tag` node, for a non-keyed `Match`. */
function valueOf<T extends NodeTag>(node: RendererNode, tag: T): NodeValue<T> | false {
  // TypeScript cannot narrow a union by a generic tag.
  return node.tag === tag ? ((node as { value?: unknown }).value as NodeValue<T>) : false;
}

function buttonVariant(variant: NodeValue<'Button'>['props']['variant']): InlineActionButtonVariant {
  if (variant === 'Primary' || variant === undefined) {
    return 'primary';
  }
  return variant === 'Secondary' ? 'secondary' : 'text';
}

function Children(props: { nodes: RendererNode[]; onAction: CustomActionHandler }): JSX.Element {
  return (
    <For each={props.nodes} keyed={false}>
      {child => <CustomNode node={child()} onAction={props.onAction} />}
    </For>
  );
}

/** What makes a text field the same field from one tree to the next. */
function fieldIdentity(value: NodeValue<'TextField'>): string {
  return `${value.props.valueChangeAction ?? ''}\u0000${value.props.label ?? ''}`;
}

function TextField(props: { value: NodeValue<'TextField'>; onAction: CustomActionHandler }): JSX.Element {
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

  // Not a `value` binding, which Solid rewrites on every tree and which would move the caret.
  createEffect(
    () => props.value.props.text,
    text => {
      if (input !== undefined) {
        hold.receive(text);
      }
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
      const text = untrack(() => props.value.props.text);
      hold.reset(text);
      input.value = text;
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
          const text = untrack(() => props.value.props.text);
          hold.reset(text);
          el.value = text;
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

/** One node of a product-authored render tree. `Nil` renders nothing. */
export function CustomNode(props: { node: RendererNode; onAction: CustomActionHandler }): JSX.Element {
  return (
    <Switch>
      <Match when={valueOf(props.node, 'String')}>{value => <>{value().text}</>}</Match>

      <Match when={valueOf(props.node, 'Box')}>
        {value => (
          <div
            class={s['box']}
            data-testid="chat-custom-box"
            style={boxStyle(value().props.contentAlignment, value().modifiers)}
          >
            <Children nodes={value().children} onAction={props.onAction} />
          </div>
        )}
      </Match>

      <Match when={valueOf(props.node, 'Column')}>
        {value => (
          <div
            class={s['column']}
            data-testid="chat-custom-column"
            style={columnStyle(value().props.horizontalAlignment, value().props.verticalArrangement, value().modifiers)}
          >
            <Children nodes={value().children} onAction={props.onAction} />
          </div>
        )}
      </Match>

      <Match when={valueOf(props.node, 'Row')}>
        {value => (
          <div
            class={s['row']}
            data-testid="chat-custom-row"
            style={rowStyle(value().props.horizontalArrangement, value().props.verticalAlignment, value().modifiers)}
          >
            <Children nodes={value().children} onAction={props.onAction} />
          </div>
        )}
      </Match>

      <Match when={valueOf(props.node, 'Spacer')}>
        {value => <div class={s['spacer']} data-testid="chat-custom-spacer" style={modifierStyle(value().modifiers)} />}
      </Match>

      <Match when={valueOf(props.node, 'Text')}>
        {value => (
          <span
            class={s['text']}
            data-testid="chat-custom-text"
            style={textStyle(value().props.style, value().props.color, value().modifiers)}
          >
            <Children nodes={value().children} onAction={props.onAction} />
          </span>
        )}
      </Match>

      <Match when={valueOf(props.node, 'Button')}>
        {value => (
          <InlineActionButton
            variant={buttonVariant(value().props.variant)}
            loading={value().props.loading === true}
            disabled={value().props.enabled === false}
            style={modifierStyle(value().modifiers)}
            testId="chat-custom-btn"
            onClick={() => {
              const action = value().props.clickAction;
              if (action !== undefined) {
                props.onAction(action);
              }
            }}
          >
            {value().props.text}
          </InlineActionButton>
        )}
      </Match>

      <Match when={valueOf(props.node, 'TextField')}>
        {value => <TextField value={value()} onAction={props.onAction} />}
      </Match>

      {/* The host frame has no fetch path for Bulletin or archive image bytes yet,
          so an image draws as empty space. */}
      <Match when={valueOf(props.node, 'Image')}>
        {value => <div class={s['image']} data-testid="chat-custom-image" style={modifierStyle(value().modifiers)} />}
      </Match>

      <Match when={valueOf(props.node, 'Effect')}>
        {value => (
          <div class={s['effect']} data-testid="chat-custom-effect" data-effect={value().props.effect.toLowerCase()}>
            <Children nodes={value().children} onAction={props.onAction} />
          </div>
        )}
      </Match>
    </Switch>
  );
}
