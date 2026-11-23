// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { type Accessor, createEffect, createSignal, lazy, Loading, onSettled, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Drawer, preloadWhenIdle, RootBoundary } from '@dotli/ui';
import type { ChatConversation } from './chat.js';
import { CHAT_PANEL_ID } from './chatPanelId.js';
import type * as ChatPanelNamespace from './ChatPanel.js';
import s from './ChatDock.module.css';

export type ChatPanelModule = typeof ChatPanelNamespace;

const PageChatPanel = lazy(() => import('./ChatPanel.js'), { export: 'ChatPanel' });

export type ChatDockProps = {
  open: Accessor<boolean>;
  /** Whether the chat button shows, which loads the panel's code while the page is idle. */
  available: Accessor<boolean>;
  /** Escape, a press outside, the close button, a swipe or a broken panel closes it. */
  onOpenChange: (open: boolean) => void;
  conversation: ChatConversation;
  /** Hands the panel's dialog over once it is on the page. Returns the hand back. */
  handOver?: ((panel: HTMLElement) => () => void) | undefined;
  /** Read once. Without one, the panel's own chunk. */
  loadPanel?: (() => Promise<ChatPanelModule>) | undefined;
};

/**
 * The product-chat panel, in a drawer over the product. A chunk that fails to load or a panel that throws is reported
 * and the panel closes, so the next open tries again.
 */
export function ChatDock(props: ChatDockProps): JSX.Element {
  const loadPanel = untrack(() => props.loadPanel);
  const ChatPanel = loadPanel === undefined ? PageChatPanel : lazy(loadPanel, { export: 'ChatPanel' });
  let body: HTMLDivElement | undefined;

  // Keeps the panel rendered while closed once it has opened.
  const [opened, setOpened] = createSignal(false);

  createEffect(
    () => props.available(),
    visible => (visible ? preloadWhenIdle(ChatPanel) : undefined),
  );
  createEffect(
    () => props.open(),
    isOpen => {
      if (isOpen) {
        setOpened(true);
      }
    },
  );
  // Lets the chat button take focus back on close unless the user moved it off the panel. The whole dialog, so focus
  // on the drawer's own head counts as inside.
  onSettled(() => {
    const dialog = body?.closest<HTMLElement>('[role="dialog"]') ?? null;
    return dialog === null ? undefined : props.handOver?.(dialog);
  });

  return (
    <Drawer
      open={props.open()}
      onOpenChange={props.onOpenChange}
      title={props.conversation.productName() ?? 'Chat'}
      id={CHAT_PANEL_ID}
      testId="chat-panel"
    >
      <div
        ref={el => {
          body = el;
        }}
        class={s['panel']}
      >
        <Show when={opened()}>
          {/* A broken panel closes and unmounts, so the next open renders it afresh. */}
          <RootBoundary
            root="chat"
            onBroken={() => {
              setOpened(false);
              props.onOpenChange(false);
            }}
          >
            <Loading>
              <ChatPanel open={props.open} conversation={props.conversation} />
            </Loading>
          </RootBoundary>
        </Show>
      </div>
    </Drawer>
  );
}
