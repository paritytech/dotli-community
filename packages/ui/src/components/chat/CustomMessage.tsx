// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Visibility gates both the live subscription and its tree's host resources.
import { createSignal, onCleanup, onSettled, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { RenderContext, RendererNode } from '@parity/truapi';
import { bytesToHex } from '@parity/truapi/scale';
import { loadRendererImage, render, userTriggerRendererAction } from '../../chat/service.js';
import { CustomNode, type CustomActionHandler, type RendererResources } from './CustomNode.js';
import s from './CustomMessage.module.css';

export interface CustomMessageProps {
  productId: string;
  roomId: string;
  messageId: string;
  messageType: string;
  /** Stored product-defined payload, hex-encoded. */
  payload: `0x${string}`;
}

interface LiveTree {
  node: RendererNode;
  resources: RendererResources;
  onAction: CustomActionHandler;
}

export function CustomMessage(props: CustomMessageProps): JSX.Element {
  // A message's identity never changes for its row.
  const mount = untrack(() => ({ ...props }));
  const [tree, setTree] = createSignal<LiveTree>();
  const [placeholder, setPlaceholder] = createSignal('Loading…');
  let root: HTMLDivElement | undefined;
  let disposed = false;
  let stopRender: (() => void) | null = null;
  const context: RenderContext = {
    tag: 'ChatMessage',
    value: { roomId: mount.roomId, messageId: mount.messageId, messageType: mount.messageType },
  };

  const startRender = (): void => {
    if (disposed || stopRender !== null) {
      return;
    }
    const lifecycle = { active: true };
    let ended = false;
    let resources: AbortController | undefined;
    let unsubscribe: (() => void) | undefined;
    const stop = (): void => {
      lifecycle.active = false;
      resources?.abort();
      unsubscribe?.();
      unsubscribe = undefined;
    };
    // Install the gate first: a render can terminate synchronously.
    stopRender = stop;
    const fail = (): void => {
      if (!lifecycle.active) {
        return;
      }
      ended = true;
      stop();
      setTree(undefined);
      setPlaceholder('This message can’t be shown right now.');
    };
    const subscription = render(
      mount.productId,
      { context, payload: mount.payload },
      {
        onUpdate: node => {
          if (!lifecycle.active || ended) {
            return;
          }
          resources?.abort();
          const controller = new AbortController();
          resources = controller;
          setTree({
            node,
            resources: {
              signal: controller.signal,
              loadImage: (source, signal) => loadRendererImage(mount.productId, source, signal),
              onError: fail,
            },
            onAction: (actionId, payload) => {
              if (!lifecycle.active || controller.signal.aborted) {
                return;
              }
              void userTriggerRendererAction(mount.productId, {
                context,
                actionId,
                payload: payload === undefined ? '0x' : bytesToHex(payload),
              }).catch(() => {
                if (!controller.signal.aborted) {
                  fail();
                }
              });
            },
          });
        },
        onComplete: () => {
          ended = true;
        },
        onError: fail,
      },
    );
    if (lifecycle.active) {
      unsubscribe = subscription;
    } else {
      subscription();
    }
  };

  const stop = (): void => {
    if (stopRender !== null) {
      stopRender();
      stopRender = null;
      setTree(undefined);
      setPlaceholder('Loading…');
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
        when={tree()}
        fallback={
          <span class={s['placeholder']} data-testid="chat-custom-placeholder">
            {placeholder()}
          </span>
        }
      >
        {live => <CustomNode node={live().node} resources={live().resources} onAction={live().onAction} />}
      </Show>
    </div>
  );
}
