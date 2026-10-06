// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One custom-message cell in the chat panel: the product's live render tree.
//
// The visibility gate is not a rendering optimization, it gates the
// subscription: a tree is live and each open render is work the product
// is doing, so a long history would otherwise hold one per row for rows
// nobody is looking at. The observer starts the subscription when the
// cell scrolls in and drops it when it leaves, like the desktop host.

import { createSignal, onCleanup, onSettled, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { HexString, RenderContext, RendererNode } from '@parity/truapi';
import { bytesToHex } from '@parity/truapi/scale';
import { renderCustomMessage, userTriggerRendererAction } from '../../chat/service.js';
import { CustomNode } from './CustomNode.js';
import s from './CustomMessage.module.css';

export interface CustomMessageProps {
  productId: string;
  roomId: string;
  messageId: string;
  messageType: string;
  /** Stored product-defined payload, hex-encoded. */
  payload: HexString;
}

export function CustomMessage(props: CustomMessageProps): JSX.Element {
  // A message's identity never changes for its row, so read it once.
  const mount = untrack(() => ({ ...props }));
  const [tree, setTree] = createSignal<RendererNode>();
  const [placeholder, setPlaceholder] = createSignal<string | undefined>('Loading…');
  let root: HTMLDivElement | undefined;
  let disposed = false;

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
    userTriggerRendererAction(mount.productId, {
      context,
      actionId,
      payload: payload === undefined ? '0x' : bytesToHex(payload),
    }).catch(() => {
      if (!disposed) {
        setPlaceholder('The app could not be reached.');
      }
    });
  };

  let stopRender: (() => void) | null = null;

  const startRender = (): void => {
    if (disposed || stopRender !== null) {
      return;
    }
    stopRender = renderCustomMessage(
      mount.productId,
      { context, payload: mount.payload },
      {
        onUpdate: node => {
          if (disposed) {
            return;
          }
          setPlaceholder(undefined);
          setTree(node);
        },
        // A failed render may have delivered a partial tree, which must not
        // stand as final; replace it with a neutral fallback.
        onError: () => {
          if (!disposed) {
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

  let observer: IntersectionObserver | null = null;
  onSettled(() => {
    if (typeof IntersectionObserver === 'undefined' || root === undefined) {
      startRender();
      return;
    }
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          startRender();
        } else {
          stop();
        }
      }
    });
    observer.observe(root);
  });
  onCleanup(() => {
    disposed = true;
    observer?.disconnect();
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
