// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, onCleanup } from 'solid-js';
import type { ChatStore } from '../runtime/chat/createChatStore.js';
import { productState } from '../runtime/state/productState.js';
import { useStore } from '@dotli/stores-solid';
import { productFrameLayout } from '../createProductFrameLayout.js';
import type { ChatConversation, ChatFeed } from '../components/chat/chat.js';
import type { ChatDockProps } from '../components/chat/ChatDock.js';
import { chatPanelState } from '../state/chatPanelState.js';
import { topbarState } from '../state/topbarState.js';

/** The open panel's view of `chat`, read only while the panel body lives. */
function openFeed(chat: ChatStore): ChatFeed {
  const productId = useStore(chatPanelState.store, state => state.runtimeProductId);
  const loadId = useStore(productState.store, state => state.loadId);
  onCleanup(chatPanelState.markFollowedRoomSeen(chat.view));
  const initial = chat.view.get();
  return {
    contacts: useStore(chat.view, state => state.contacts, { initial }),
    contactsFailed: useStore(chat.view, state => state.contactsFailed, { initial }),
    messages: useStore(chat.view, state => state.messages, { initial }),
    messagesFailed: useStore(chat.view, state => state.messagesFailed, { initial }),
    onChange: listener => chat.view.listen(listener),
    follow: shown => {
      createEffect(
        () => {
          const id = productId();
          return id === null ? null : { productId: id, roomId: shown(), loadId: loadId() };
        },
        target => {
          chat.follow(target);
        },
      );
      onCleanup(() => {
        chat.follow(null);
      });
    },
  };
}

/** What the chat panel shows of the page's chat state, for an island's own lifetime. */
function useChatConversation(chat: ChatStore): ChatConversation {
  // Slices, so a width drag or the composer-focus flag never re-runs the rows.
  const label = useStore(chatPanelState.store, state => state.label);
  const displayName = useStore(productState.store, state =>
    state.status === 'loaded' ? state.facts.displayName : undefined,
  );

  function send(roomId: string, text: string): Promise<void> {
    const productId = chatPanelState.store.get().runtimeProductId;
    // The panel only opens for a loaded product, so there is always one while it can send.
    return productId === null ? Promise.resolve() : chat.postUserMessage({ productId, roomId, text });
  }

  return {
    loggedIn: useStore(chatPanelState.store, state => state.loggedIn),
    productName: () => displayName() ?? label(),
    activeRoomId: useStore(chatPanelState.store, state => state.activeRoomId),
    unreadByRoom: useStore(chatPanelState.store, state => state.unreadByRoom),
    composerError: useStore(chatPanelState.store, state => state.composerError),
    openFeed: () => openFeed(chat),
    openRoom: chatPanelState.openRoom,
    backToRooms: chatPanelState.backToRooms,
    roomGone: chatPanelState.backToRooms,
    claimComposerFocus: chatPanelState.claimComposerFocus,
    setComposerError: chatPanelState.setComposerError,
    send,
    actions: chat,
  };
}

/**
 * The docked panel's props, for an island's own lifetime. It keeps the product frame clear of the open panel through
 * `reserveRight`, which takes the px the panel covers at the page's right edge.
 */
export function useChatDock(
  chat: ChatStore,
  reserveRight: (px: number) => void = productFrameLayout.setChatWidth,
): ChatDockProps {
  const open = useStore(chatPanelState.store, state => state.open);
  const width = useStore(chatPanelState.store, state => state.width);
  createEffect(
    () => (open() ? width() : 0),
    (px, previous) => {
      if (px !== 0 || (previous ?? 0) !== 0) {
        reserveRight(px);
      }
    },
  );
  return {
    open,
    width,
    topbarHidden: useStore(topbarState.store, state => !state.visible),
    available: useStore(chatPanelState.store, chatPanelState.isButtonVisible),
    onClose: () => {
      chatPanelState.setOpen(false);
    },
    onResize: chatPanelState.setWidth,
    onResizeEnd: chatPanelState.persistWidth,
    conversation: useChatConversation(chat),
    handOver: chatPanelState.setElement,
  };
}
