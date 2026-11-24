// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Product strings land as JSX text and every style comes from the closed mapping in customStyles.ts.
// Nodes match by tag and children by position, so an updated tree keeps a focused field's caret and text.

import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ImageSource, RendererNode } from '@parity/truapi';
import { InlineActionButton, type InlineActionButtonVariant } from './InlineActionButton.js';
import { ImageOffIcon } from './ImageOffIcon.js';
import { boxStyle, columnStyle, imageStyle, modifierStyle, rowStyle, textStyle } from './customStyles.js';
import { createEchoHold } from './echoHold.js';
import { ImageUnavailableError } from './imageUnavailableError.js';
import { reportUnavailableImage } from './reportUnavailableImage.js';
import type { LoadedImage } from './readChatImage.js';
import s from './CustomNode.module.css';

/** Reports a user gesture inside a rendered tree back to the product. */
export type CustomActionHandler = (actionId: string, payload?: Uint8Array) => void;

/** Resolves an image a tree names. Rejects when it cannot be drawn, and with the signal's reason once it aborts. */
export type CustomImageLoad = (source: ImageSource, signal: AbortSignal) => Promise<LoadedImage>;

/** What a rendered tree asks of the message around it. */
type NodeHost = { onAction: CustomActionHandler; loadImage: CustomImageLoad };

/** An image node's bytes: on their way, drawn from an object URL, or unavailable. */
type ImageState = { kind: 'loading' } | { kind: 'loaded'; url: string } | { kind: 'unavailable' };

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

function Children(props: NodeHost & { nodes: RendererNode[] }): JSX.Element {
  return (
    <For each={props.nodes} keyed={false}>
      {child => <CustomNode node={child()} onAction={props.onAction} loadImage={props.loadImage} />}
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

/** What makes an image the same image from one tree to the next. */
function sourceIdentity(source: ImageSource): string {
  return `${source.tag}\u0000${source.value}`;
}

/**
 * Draws its source once loaded, sized by its modifiers or else at its natural size. It keeps a box while loading and
 * shows bytes that fail to load or decode as unavailable.
 */
function CustomImage(props: { value: NodeValue<'Image'>; loadImage: CustomImageLoad }): JSX.Element {
  const [state, setState] = createSignal<ImageState>({ kind: 'loading' });
  // A memo, so a new tree that names the same source keeps the drawn image.
  const identity = createMemo(() => sourceIdentity(props.value.props.source));
  createEffect(identity, () => {
    const source = untrack(() => props.value.props.source);
    const aborter = new AbortController();
    let url: string | null = null;
    setState({ kind: 'loading' });
    props.loadImage(source, aborter.signal).then(
      image => {
        if (aborter.signal.aborted) {
          return;
        }
        url = URL.createObjectURL(new Blob([image.bytes.slice()], { type: image.type }));
        setState({ kind: 'loaded', url });
      },
      () => {
        if (!aborter.signal.aborted) {
          setState({ kind: 'unavailable' });
        }
      },
    );
    return () => {
      aborter.abort();
      if (url !== null) {
        URL.revokeObjectURL(url);
      }
    };
  });
  const loadedUrl = (): string | false => {
    const current = state();
    return current.kind === 'loaded' && current.url;
  };
  return (
    <Switch
      fallback={
        <div
          class={s['imageSlot']}
          data-testid="chat-custom-image"
          data-state={state().kind}
          role="img"
          aria-label={state().kind === 'unavailable' ? 'Image unavailable' : 'Image loading'}
          style={modifierStyle(props.value.modifiers)}
        >
          <Show when={state().kind === 'unavailable'} fallback={<span class={s['shimmer']} />}>
            <ImageOffIcon size={22} />
            <span class={s['imageNote']}>Image unavailable</span>
          </Show>
        </div>
      }
    >
      <Match when={loadedUrl()}>
        {url => (
          <img
            class={s['image']}
            data-testid="chat-custom-image"
            data-state="loaded"
            alt=""
            src={url()}
            style={imageStyle(props.value.props.fit, props.value.modifiers)}
            onError={() => {
              reportUnavailableImage(
                new ImageUnavailableError('undecodable', 'The browser could not decode an image'),
                'chat_image_decode',
              );
              setState({ kind: 'unavailable' });
            }}
          />
        )}
      </Match>
    </Switch>
  );
}

/** One node of a product-authored render tree. `Nil` renders nothing. */
export function CustomNode(props: NodeHost & { node: RendererNode }): JSX.Element {
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
            <Children nodes={value().children} onAction={props.onAction} loadImage={props.loadImage} />
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
            <Children nodes={value().children} onAction={props.onAction} loadImage={props.loadImage} />
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
            <Children nodes={value().children} onAction={props.onAction} loadImage={props.loadImage} />
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
            <Children nodes={value().children} onAction={props.onAction} loadImage={props.loadImage} />
          </span>
        )}
      </Match>

      <Match when={valueOf(props.node, 'Button')}>
        {value => (
          <InlineActionButton
            variant={buttonVariant(value().props.variant)}
            loading={value().props.loading === true}
            // A button with nothing to report draws as disabled, so it never looks pressable.
            disabled={value().props.enabled === false || value().props.clickAction === undefined}
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

      <Match when={valueOf(props.node, 'Image')}>
        {value => <CustomImage value={value()} loadImage={props.loadImage} />}
      </Match>

      {/* The host has no materials renderer yet, so the children draw without the layers. */}
      <Match when={valueOf(props.node, 'Materials')}>
        {value => (
          <div class={s['materials']} data-testid="chat-custom-materials">
            <Children nodes={value().children} onAction={props.onAction} loadImage={props.loadImage} />
          </div>
        )}
      </Match>
    </Switch>
  );
}
