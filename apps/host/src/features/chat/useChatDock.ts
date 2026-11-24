// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, createMemo, onCleanup } from 'solid-js';
import type { ChatStore } from './createChatStore.js';
import { productState } from '../page/index.js';
import { getActiveTldSuffix } from '@dotli/config';
import { useStore } from '@dotli/stores-solid';
import type { ChatConversation, ChatFeed } from './chat.js';
import type { ChatDockProps } from './ChatDock.js';
import { chatPanelState } from './chatPanelState.js';
import { contactEntries, getShownContact } from './contacts.js';

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
  // Slices, so the composer-focus flag never re-runs the rows.
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
    productDomain: () => {
      const name = label();
      return name === null ? null : name + getActiveTldSuffix();
    },
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

/** The chat drawer's props, for an island's own lifetime. */
export function useChatDock(chat: ChatStore): ChatDockProps {
  const conversation = useChatConversation(chat);
  // The view the open panel follows, so its rooms are null while the drawer is closed.
  const contacts = useStore(chat.view, state => state.contacts, { initial: chat.view.get() });
  return {
    open: useStore(chatPanelState.store, state => state.open),
    available: useStore(chatPanelState.store, chatPanelState.isButtonVisible),
    onOpenChange: chatPanelState.setOpen,
    conversation,
    shown: createMemo(() => {
      const read = contacts();
      const entries = read === null ? null : contactEntries(read.rooms, read.lastMessageTimes);
      return getShownContact(entries, conversation.activeRoomId());
    }),
    handOver: chatPanelState.setElement,
  };
}
