// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Visibility gates the render subscription, not just painting: each open render is live work for the
// product, so only rows in view hold one.

import { createSignal, onCleanup, onSettled, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { HexString, RenderContext, RendererNode } from '@parity/truapi';
import { toHex } from '@dotli/shared';
import { CustomNode } from './CustomNode.js';
import type { ChatMessageActions } from './chat.js';
import { visibilityWatcher, type WatchVisibility } from './visibility.js';
import s from './CustomMessage.module.css';

export type CustomMessageProps = {
  chat: Pick<ChatMessageActions, 'renderCustomMessage' | 'triggerRendererAction'>;
  /** Without one, the browser's IntersectionObserver. */
  watchVisibility?: WatchVisibility | undefined;
  productId: string;
  roomId: string;
  messageId: string;
  messageType: string;
  /** Stored product-defined payload, hex-encoded. */
  payload: HexString;
};

export function CustomMessage(props: CustomMessageProps): JSX.Element {
  // A message's identity never changes for its row, so read it once.
  const mount = untrack(() => ({ ...props }));
  const [tree, setTree] = createSignal<RendererNode>();
  const [placeholder, setPlaceholder] = createSignal<string | undefined>('Loading…');
  let root: HTMLDivElement | undefined;
  // Aborted as the row leaves the page, so the product's late answers change nothing.
  const shown = new AbortController();

  // The same context names the body on the render request and on every
  // action fired inside it, so the product can pair the two.
  const context: RenderContext = {
    tag: 'ChatMessage',
    value: {
      roomId: mount.roomId,
      messageId: mount.messageId,
      messageType: mount.messageType,
    },
  };

  const onAction = (actionId: string, payload?: Uint8Array): void => {
    mount.chat
      .triggerRendererAction(mount.productId, {
        context,
        actionId,
        payload: payload === undefined ? '0x' : toHex(payload),
      })
      .catch(() => {
        if (!shown.signal.aborted) {
          setPlaceholder('The app could not be reached.');
        }
      });
  };

  let stopRender: (() => void) | null = null;

  const startRender = (): void => {
    if (shown.signal.aborted || stopRender !== null) {
      return;
    }
    stopRender = mount.chat.renderCustomMessage(
      mount.productId,
      { context, payload: mount.payload },
      {
        onUpdate: node => {
          if (shown.signal.aborted) {
            return;
          }
          setPlaceholder(undefined);
          setTree(node);
        },
        // A failed render may have delivered a partial tree, which must not stand as final.
        onError: () => {
          if (!shown.signal.aborted) {
            setPlaceholder('This message can’t be shown right now.');
          }
        },
      },
    );
  };

  const stop = (): void => {
    if (stopRender !== null) {
      stopRender();
      stopRender = null;
    }
  };

  onSettled(() => {
    if (root === undefined) {
      startRender();
      return undefined;
    }
    const watch = mount.watchVisibility ?? visibilityWatcher(globalThis.IntersectionObserver);
    return watch(root, visible => {
      if (visible) {
        startRender();
      } else {
        stop();
      }
    });
  });
  onCleanup(() => {
    shown.abort();
    stop();
  });

  return (
    <div
      class={s['root']}
      data-testid="chat-custom-root"
      ref={el => {
        root = el;
      }}
    >
      <Show
        when={placeholder()}
        fallback={<Show when={tree()}>{node => <CustomNode node={node()} onAction={onAction} />}</Show>}
      >
        {text => (
          <span class={s['placeholder']} data-testid="chat-custom-placeholder">
            {text()}
          </span>
        )}
      </Show>
    </div>
  );
}
