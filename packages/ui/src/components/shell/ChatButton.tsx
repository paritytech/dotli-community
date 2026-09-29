// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, useContext } from 'solid-js';
import type { JSX } from '@solidjs/web';
import {
  chatButtonVisible,
  chatPanelStore,
  chatUnreadLabel,
  setChatPanelOpen,
  totalChatUnread,
} from '../../state/chat-panel.js';
import { useStore } from '../use-store.js';
import { focusLostOrInside, focusTrigger } from './popover.js';
import { TOPBAR_PRIORITY } from './topbar/fit.js';
import { TopbarContext } from './topbar/context.js';
import { TopbarItem } from './topbar/TopbarItem.js';

function ChatIcon(props: { size: number }): JSX.Element {
  return (
    <svg
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/**
 * The topbar's chat button (`#chat-button`), which opens and closes the
 * docked chat panel (chat/panel.ts). It shows while the loaded product has
 * chat and a session is active (chatButtonVisible), and carries the unread
 * count while the panel is closed (the room rows carry their own while it is
 * open). When the panel closes with focus inside it (Escape, its own close
 * button), focus comes back here, or to the More button while the bar has
 * collapsed this one.
 */
export function ChatButton(): JSX.Element {
  let button: HTMLButtonElement | undefined;
  const bar = useContext(TopbarContext);
  // Slices: the store is written on every chat message and every move of a
  // panel-width drag.
  const visible = useStore(chatPanelStore, chatButtonVisible);
  const open = useStore(chatPanelStore, state => state.open);
  const unread = useStore(chatPanelStore, state => (state.open ? 0 : totalChatUnread(state)));

  const toggle = (): void => {
    setChatPanelOpen(!chatPanelStore.get().open);
  };

  let wasOpen = false;
  createEffect(open, isOpen => {
    const closed = wasOpen && !isOpen;
    wasOpen = isOpen;
    if (!closed) {
      return;
    }
    if (focusLostOrInside(document.getElementById('chat-panel') ?? undefined)) {
      focusTrigger(button, bar?.moreButton());
    }
  });

  return (
    <TopbarItem
      name="chat"
      label="Chat"
      icon={() => <ChatIcon size={14} />}
      priority={TOPBAR_PRIORITY.chat}
      visible={visible()}
      activate={toggle}
    >
      <button
        ref={el => {
          button = el;
          el.addEventListener('click', toggle);
        }}
        id="chat-button"
        class={['topbar-btn', { active: open() }]}
        title="Chat"
        aria-label="Chat"
        aria-expanded={open() ? 'true' : 'false'}
        aria-controls="chat-panel"
        hidden={!visible()}
      >
        <ChatIcon size={12} />
        <span class="chat-unread-badge" id="chat-unread-badge" hidden={unread() === 0}>
          {unread() === 0 ? '' : chatUnreadLabel(unread())}
        </span>
      </button>
    </TopbarItem>
  );
}
