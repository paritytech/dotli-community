// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Visibility gates the render subscription, not just painting: each open render is live work for the
// product, so only rows in view hold one.

import { createSignal, onCleanup, onSettled, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { HexString, RenderContext, RendererNode } from '@parity/truapi';
import { toHex } from '@dotli/shared';
import { Spinner } from '@dotli/ui';
import { CircleAlertIcon } from '@dotli/ui/icons';
import { CustomNode } from './renderer/CustomNode.js';
import type { CustomImageLoad } from './renderer/types.js';
import type { ChatMessageActions } from './chat.js';
import { visibilityWatcher, type WatchVisibility } from './visibility.js';
import s from './CustomMessage.module.css';

const LOADING = 'Loading…';

export type CustomMessageProps = {
  chat: Pick<ChatMessageActions, 'renderCustomMessage' | 'triggerRendererAction' | 'loadImage'>;
  /** Without one, the browser's IntersectionObserver. */
  watchVisibility?: WatchVisibility | undefined;
  productId: string;
  /** What the body is drawn for. Goes verbatim on the render request and on every action fired inside it. */
  context: RenderContext;
  /** Stored product-defined payload, hex-encoded. */
  payload: HexString;
};

/** Draws a product's custom body from props it reads once, so a caller remounts it, keyed, to draw another body. */
export function CustomMessage(props: CustomMessageProps): JSX.Element {
  // A body's identity never changes, so read it once.
  const mount = untrack(() => ({ ...props }));
  const [tree, setTree] = createSignal<RendererNode>();
  const [placeholder, setPlaceholder] = createSignal<string | undefined>(LOADING);
  // Under the tree, which stays usable after a tap that did not reach the app.
  const [actionFailed, setActionFailed] = createSignal(false);
  let root: HTMLDivElement | undefined;

  const { context } = mount;

  const onAction = (actionId: string, payload?: Uint8Array): void => {
    setActionFailed(false);
    mount.chat
      .triggerRendererAction(mount.productId, {
        context,
        actionId,
        payload: payload === undefined ? '0x' : toHex(payload),
      })
      .catch(() => {
        setActionFailed(true);
      });
  };

  const loadImage: CustomImageLoad = (source, signal) => mount.chat.loadImage(mount.productId, source, signal);

  let stopRender: (() => void) | null = null;

  const startRender = (): void => {
    if (stopRender !== null) {
      return;
    }
    stopRender = mount.chat.renderCustomMessage({
      productId: mount.productId,
      request: { context, payload: mount.payload },
      sink: {
        onUpdate: node => {
          setPlaceholder(undefined);
          setTree(node);
        },
        // A failed render may have delivered a partial tree, which must not stand as final.
        onError: () => {
          setPlaceholder('This message can’t be shown right now.');
        },
      },
    });
  };

  const stop = (): void => {
    if (stopRender !== null) {
      stopRender();
      stopRender = null;
    }
  };

  onSettled(() => {
    if (root === undefined) {
      return undefined;
    }
    const watch = mount.watchVisibility ?? visibilityWatcher(IntersectionObserver);
    return watch(root, visible => {
      if (visible) {
        startRender();
      } else {
        stop();
      }
    });
  });
  onCleanup(stop);

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
        fallback={
          <Show when={tree()}>{node => <CustomNode node={node()} onAction={onAction} loadImage={loadImage} />}</Show>
        }
      >
        {text => (
          <span class={s['placeholder']} data-testid="chat-custom-placeholder">
            <Show when={text() === LOADING}>
              <Spinner class={s['spinner']} />
            </Show>
            {text()}
          </span>
        )}
      </Show>
      <Show when={actionFailed()}>
        <span class={s['error']} role="alert" data-testid="chat-custom-error">
          <CircleAlertIcon class={s['errorIcon']} size={14} />
          The app could not be reached. Try again.
        </span>
      </Show>
    </div>
  );
}
