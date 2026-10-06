// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Renders a product-authored render tree (chat custom messages) as host UI.
//
// Product strings land as JSX text, so they can never inject markup, and
// every style comes from the closed mapping in chat/custom-styles.ts.
//
// A new tree from the product updates the one on screen in place: a node
// is matched by its tag and its children by position, so an element whose
// tag stays the same is kept. A text field being typed in therefore keeps
// its focus, caret and typed text across updates, and its value is only
// written when the product changes the text it sends (and, while the user
// is typing, only once they pause: see TextField).

import { createEffect, createUniqueId, For, Match, onCleanup, Show, Switch, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ImageFit, ImageSource, RendererNode } from '@parity/truapi';
import { boxStyle, columnStyle, modifierStyle, rowStyle, textStyle } from '../../chat/custom-styles.js';
import { ChatActionButton, type ChatActionButtonVariant } from '../primitives/ChatActionButton.js';
import s from './CustomNode.module.css';

/** Reports a user gesture inside a rendered tree back to the product. */
export type CustomActionHandler = (actionId: string, payload?: Uint8Array) => void;

/** Resources belong to one streamed tree, not the message's lifetime. */
export interface RendererResources {
  signal: AbortSignal;
  loadImage(source: ImageSource, signal: AbortSignal): Promise<Blob>;
  onError(error: Error): void;
}

const IMAGE_FIT_CSS = {
  None: 'none',
  Fill: 'fill',
  Cover: 'cover',
  Contain: 'contain',
  ScaleDown: 'scale-down',
} as const satisfies Record<ImageFit, string>;

type NodeTag = Exclude<RendererNode['tag'], 'Nil'>;
type NodeValues = {
  [N in RendererNode as N['tag']]: N extends { value: infer V } ? V : never;
};
type NodeValue<T extends NodeTag> = NodeValues[T];

const textEncoder = new TextEncoder();

/** `node`'s value when it is a `tag` node, for a non-keyed `Match`. */
function valueOf<T extends NodeTag>(node: RendererNode, tag: T): NodeValue<T> | false {
  // A matching tag is a node whose value is NodeValue<T>; TypeScript
  // cannot narrow a union by a generic tag, so say so once here.
  return node.tag === tag ? ((node as { value?: unknown }).value as NodeValue<T>) : false;
}

function buttonVariant(variant: NodeValue<'Button'>['props']['variant']): ChatActionButtonVariant {
  if (variant === 'Primary' || variant === undefined) {
    return 'primary';
  }
  return variant === 'Secondary' ? 'secondary' : 'text';
}

function Children(props: {
  nodes: RendererNode[];
  onAction: CustomActionHandler;
  resources: RendererResources | undefined;
}): JSX.Element {
  return (
    <For each={props.nodes} keyed={false}>
      {child => <CustomNode node={child()} onAction={props.onAction} resources={props.resources} />}
    </For>
  );
}

/**
 * What makes a text field the same field from one tree to the next: the
 * action its edits report and its label.
 */
function fieldIdentity(value: NodeValue<'TextField'>): string {
  return `${value.props.valueChangeAction ?? ''}\u0000${value.props.label ?? ''}`;
}

/**
 * How long after the last keystroke a focused field still counts as being
 * typed in. Product text that arrives meanwhile is held until then.
 */
const TYPING_HOLD_MS = 1000;

function TextField(props: { value: NodeValue<'TextField'>; onAction: CustomActionHandler }): JSX.Element {
  const inputId = createUniqueId();
  let input: HTMLInputElement | undefined;
  // The product text last seen, applied or held.
  let written: string | undefined;
  // Product text that arrived while the user was typing, and the timer that
  // applies it once typing pauses.
  let held: string | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let lastTypedAt = Number.NEGATIVE_INFINITY;

  const apply = (text: string): void => {
    if (input !== undefined && input.value !== text) {
      input.value = text;
    }
  };
  const dropHeld = (): void => {
    held = undefined;
    if (holdTimer !== undefined) {
      clearTimeout(holdTimer);
      holdTimer = undefined;
    }
  };
  // Apply the held text when typing has paused, or wait for the pause.
  const settleHeld = (): void => {
    holdTimer = undefined;
    if (held === undefined) {
      return;
    }
    const wait = lastTypedAt + TYPING_HOLD_MS - Date.now();
    if (wait > 0 && document.activeElement === input) {
      holdTimer = setTimeout(settleHeld, wait);
      return;
    }
    const text = held;
    held = undefined;
    apply(text);
  };
  onCleanup(dropHeld);

  // Not a `value` binding, which Solid rewrites on every new tree: the value
  // is written only when the product sends different text, and not even
  // then when the field already shows it, so resending the same text never
  // overwrites what the user is typing or moves their caret. The product
  // echoes each edit back after a round trip, so an echo of an earlier
  // keystroke can land while the user types on: text that arrives while the
  // field is focused and was typed in within TYPING_HOLD_MS is held, and
  // applied when typing pauses, if it still differs from the field.
  createEffect(
    () => props.value.props.text,
    text => {
      if (input === undefined || text === written) {
        return;
      }
      written = text;
      if (document.activeElement === input && Date.now() - lastTypedAt < TYPING_HOLD_MS) {
        held = text;
        holdTimer ??= setTimeout(settleHeld, lastTypedAt + TYPING_HOLD_MS - Date.now());
        return;
      }
      dropHeld();
      apply(text);
    },
  );
  // Children are matched by position, so a field the product inserts or
  // removes above this one hands this element another field. Start that
  // field fresh, as a new element would: its own text, and not the focus
  // the user had in the other field.
  createEffect(
    () => fieldIdentity(props.value),
    (identity, previous) => {
      if (input === undefined || previous === undefined || identity === previous) {
        return;
      }
      dropHeld();
      lastTypedAt = Number.NEGATIVE_INFINITY;
      written = untrack(() => props.value.props.text);
      input.value = written;
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
          written = untrack(() => props.value.props.text);
          el.value = written;
        }}
        id={inputId}
        type="text"
        class={s['fieldInput']}
        placeholder={props.value.props.placeholder}
        disabled={props.value.props.enabled === false}
        onInput={event => {
          lastTypedAt = Date.now();
          const action = props.value.props.valueChangeAction;
          if (action !== undefined) {
            props.onAction(action, textEncoder.encode(event.currentTarget.value));
          }
        }}
      />
    </div>
  );
}

function Image(props: { value: NodeValue<'Image'>; resources: RendererResources | undefined }): JSX.Element {
  let image: HTMLImageElement | undefined;
  createEffect(
    () => ({ source: props.value.props.source, resources: props.resources }),
    ({ source, resources }) => {
      if (resources === undefined) {
        throw new Error('Image rendering requires host resources');
      }
      if (resources.signal.aborted || image === undefined) {
        return;
      }
      const element = image;
      const load = new AbortController();
      let active = true;
      let url: string | undefined;
      const dispose = (): void => {
        if (!active) {
          return;
        }
        active = false;
        load.abort();
        element.removeAttribute('src');
        if (url !== undefined) {
          URL.revokeObjectURL(url);
          url = undefined;
        }
      };
      const fail = (error: unknown): void => {
        if (active && !resources.signal.aborted) {
          resources.onError(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const decodeError = (): void => {
        fail(new Error('Renderer image could not be decoded'));
      };
      element.addEventListener('error', decodeError);
      resources.signal.addEventListener('abort', dispose, { once: true });
      void resources
        .loadImage(source, load.signal)
        .then(blob => {
          if (active && !resources.signal.aborted) {
            url = URL.createObjectURL(blob);
            element.src = url;
          }
        })
        .catch(fail);
      // Solid's effect callback has no owner; its returned disposer runs on
      // both dependency replacement and node removal.
      return () => {
        resources.signal.removeEventListener('abort', dispose);
        element.removeEventListener('error', decodeError);
        dispose();
      };
    },
  );
  return (
    <img
      ref={el => {
        image = el;
      }}
      class={s['image']}
      data-testid="chat-custom-image"
      alt=""
      style={{ 'object-fit': IMAGE_FIT_CSS[props.value.props.fit ?? 'Fill'], ...modifierStyle(props.value.modifiers) }}
    />
  );
}

function Effect(props: {
  value: NodeValue<'Effect'>;
  onAction: CustomActionHandler;
  resources: RendererResources | undefined;
}): JSX.Element {
  let tint: HTMLSpanElement | undefined;
  createEffect(
    () => props.resources,
    resources => {
      if (
        tint === undefined ||
        resources?.signal.aborted === true ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        return;
      }
      const animation = tint.animate([{ filter: 'hue-rotate(0deg)' }, { filter: 'hue-rotate(360deg)' }], {
        duration: 4000,
        iterations: Infinity,
      });
      let active = true;
      const cancel = (): void => {
        if (!active) {
          return;
        }
        active = false;
        animation.cancel();
      };
      resources?.signal.addEventListener('abort', cancel, { once: true });
      return () => {
        resources?.signal.removeEventListener('abort', cancel);
        cancel();
      };
    },
  );
  return (
    <div class={s['effect']} data-testid="chat-custom-effect" data-effect={props.value.props.effect.toLowerCase()}>
      <Children nodes={props.value.children} onAction={props.onAction} resources={props.resources} />
      <span
        ref={el => {
          tint = el;
        }}
        class={s['tint']}
        data-testid="chat-custom-effect-tint"
        aria-hidden="true"
      />
    </div>
  );
}

/** One node of a product-authored render tree. `Nil` renders nothing. */
export function CustomNode(props: {
  node: RendererNode;
  onAction: CustomActionHandler;
  resources?: RendererResources | undefined;
}): JSX.Element {
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
            <Children nodes={value().children} onAction={props.onAction} resources={props.resources} />
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
            <Children nodes={value().children} onAction={props.onAction} resources={props.resources} />
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
            <Children nodes={value().children} onAction={props.onAction} resources={props.resources} />
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
            <Children nodes={value().children} onAction={props.onAction} resources={props.resources} />
          </span>
        )}
      </Match>

      <Match when={valueOf(props.node, 'Button')}>
        {value => (
          <ChatActionButton
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
            <Children nodes={value().children} onAction={props.onAction} resources={props.resources} />
          </ChatActionButton>
        )}
      </Match>

      <Match when={valueOf(props.node, 'TextField')}>
        {value => <TextField value={value()} onAction={props.onAction} />}
      </Match>

      <Match when={valueOf(props.node, 'Image')}>
        {value => <Image value={value()} resources={props.resources} />}
      </Match>

      <Match when={valueOf(props.node, 'Effect')}>
        {value => <Effect value={value()} onAction={props.onAction} resources={props.resources} />}
      </Match>
    </Switch>
  );
}
