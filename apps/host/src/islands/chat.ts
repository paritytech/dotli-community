// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, onCleanup } from 'solid-js';
import type { ChatStore } from '../runtime/chat/store.js';
import { productStore } from '../runtime/state/product.js';
import { useStore } from '@dotli/ui';
import { setChatWidth } from '../product-frame-layout.js';
import type { ChatConversation, ChatFeed } from '../components/chat/chat.js';
import type { ChatDockProps } from '../components/chat/ChatDock.js';
import {
  backToChatRooms,
  chatButtonVisible,
  chatPanelStore,
  clearActiveChatRoom,
  consumeComposerFocus,
  currentChatProductId,
  markFollowedRoomSeen,
  openChatRoom,
  persistChatPanelWidth,
  setChatComposerError,
  setChatPanelElement,
  setChatPanelOpen,
  setChatPanelWidth,
} from '../state/chat-panel.js';

/** The open panel's view of `chat`, read only while the panel body lives. */
function openFeed(chat: ChatStore): ChatFeed {
  const productId = useStore(chatPanelStore, currentChatProductId);
  const loadId = useStore(productStore, state => state.loadId);
  onCleanup(markFollowedRoomSeen(chat.view));
  return {
    contacts: useStore(chat.view, state => state.contacts),
    contactsFailed: useStore(chat.view, state => state.contactsFailed),
    messages: useStore(chat.view, state => state.messages),
    messagesFailed: useStore(chat.view, state => state.messagesFailed),
    onChange: listener => chat.view.subscribe(listener),
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
  // Slices, so a width drag, a topbar toggle or the composer-focus flag never re-runs the rows.
  const label = useStore(chatPanelStore, state => state.label);
  const displayName = useStore(productStore, state => (state.status === 'loaded' ? state.displayName : undefined));
  return {
    loggedIn: useStore(chatPanelStore, state => state.loggedIn),
    productName: () => displayName() ?? label(),
    activeRoomId: useStore(chatPanelStore, state => state.activeRoomId),
    unreadByRoom: useStore(chatPanelStore, state => state.unreadByRoom),
    composerError: useStore(chatPanelStore, state => state.composerError),
    openFeed: () => openFeed(chat),
    openRoom: openChatRoom,
    backToRooms: backToChatRooms,
    roomGone: clearActiveChatRoom,
    claimComposerFocus: () => {
      if (!chatPanelStore.get().focusComposer) {
        return false;
      }
      consumeComposerFocus();
      return true;
    },
    setComposerError: setChatComposerError,
    send: (roomId, text) => {
      const productId = currentChatProductId();
      // The panel only opens for a loaded product, so there is always one while it can send.
      return productId === null ? Promise.resolve() : chat.postUserMessage(productId, roomId, text);
    },
    actions: chat,
  };
}

/**
 * The docked panel's props, for an island's own lifetime. It keeps the product frame clear of the open panel through
 * `reserveRight`, which takes the px the panel covers at the page's right edge.
 */
export function useChatDock(chat: ChatStore, reserveRight: (px: number) => void = setChatWidth): ChatDockProps {
  const open = useStore(chatPanelStore, state => state.open);
  const width = useStore(chatPanelStore, state => state.width);
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
    topbarHidden: useStore(chatPanelStore, state => !state.topbarVisible),
    available: useStore(chatPanelStore, chatButtonVisible),
    onClose: () => {
      setChatPanelOpen(false);
    },
    onResize: setChatPanelWidth,
    onResizeEnd: persistChatPanelWidth,
    conversation: useChatConversation(chat),
    handOver: setChatPanelElement,
  };
}
