// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { type Accessor, createEffect, lazy, Loading, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Drawer, preloadWhenIdle, RootBoundary } from '@dotli/ui';
import type { ChatConversation } from './chat.js';
import { ChatHead } from './ChatHead.js';
import { CHAT_PANEL_ID } from './chatPanelId.js';
import type { ShownContact } from './contacts.js';
import type * as ChatPanelNamespace from './ChatPanel.js';
import s from './ChatDock.module.css';

export type ChatPanelModule = typeof ChatPanelNamespace;

const PageChatPanel = lazy(() => import('./ChatPanel.js'), { export: 'ChatPanel' });

export type ChatDockProps = {
  open: Accessor<boolean>;
  /** Whether the chat button shows, which loads the panel's code while the page is idle. */
  available: Accessor<boolean>;
  /** Escape inside it, the close button, a swipe, a press on the phone sheet's scrim or a broken panel closes it. */
  onOpenChange: (open: boolean) => void;
  conversation: ChatConversation;
  /** The room the open panel shows, named in the drawer's head. Null, as while the drawer is closed, shows "Chat". */
  shown: Accessor<ShownContact | null>;
  /** The chat button, or what stands in for it, which a keyboard close returns focus to. */
  restoreFocus?: (() => HTMLElement | undefined) | undefined;
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
  createEffect(
    () => props.available(),
    visible => (visible ? preloadWhenIdle(ChatPanel) : undefined),
  );
  return (
    <Drawer
      open={props.open()}
      onOpenChange={props.onOpenChange}
      // Not keyed, so the head stays in place as the room's row changes, and a focused back button keeps its focus.
      title={
        <Show when={props.shown()} fallback="Chat">
          {shown => <ChatHead shown={shown()} onBack={props.conversation.backToRooms} />}
        </Show>
      }
      id={CHAT_PANEL_ID}
      testId="chat-panel"
      restoreFocus={props.restoreFocus}
      // A pointer close leaves focus out of the bar, which would unfold on it.
      pointerCloseFocus="document"
    >
      <div class={s['panel']}>
        {/* A broken panel closes, and the drawer renders it afresh at the next opening. */}
        <RootBoundary
          root="chat"
          onBroken={() => {
            props.onOpenChange(false);
          }}
        >
          <Loading>
            <ChatPanel conversation={props.conversation} />
          </Loading>
        </RootBoundary>
      </div>
    </Drawer>
  );
}
