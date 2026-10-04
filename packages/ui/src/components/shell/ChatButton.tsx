// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, useContext } from 'solid-js';
import type { JSX } from '@solidjs/web';
import {
  chatButtonVisible,
  chatPanelStore,
  chatUnreadLabel,
  getChatPanelElement,
  setChatPanelOpen,
  totalChatUnread,
} from '../../state/chat-panel.js';
import { Chip } from '../primitives/Chip.js';
import { IconButton } from '../primitives/IconButton.js';
import { useStore } from '../use-store.js';
import { focusLostOrInside, focusTrigger } from './create-popover.js';
import { TOPBAR_PRIORITY } from './topbar/fit.js';
import { TopbarContext } from './topbar/context.js';
import { TopbarItem } from './topbar/TopbarItem.js';
import s from './ChatButton.module.css';

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
 * docked chat panel (components/chat/ChatDock.tsx). It shows while the loaded
 * product has chat and a session is active (chatButtonVisible), shows pressed
 * (`data-active`) while the panel is open, and carries the unread count while
 * the panel is closed (the room rows carry their own while it is open).
 * Collapsed into More (always, on a phone), the count moves to its Chat row
 * and More raises an info badge for it. When the panel closes with focus
 * inside it (Escape, its own close button), focus comes back here, or to the
 * More button while the bar has collapsed this one.
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
    if (focusLostOrInside(getChatPanelElement())) {
      focusTrigger(button, bar?.moreButton());
    }
  });

  return (
    <TopbarItem
      name="chat"
      label="Chat"
      icon={() => <ChatIcon size={14} />}
      alert={unread() === 0 ? undefined : { tone: 'info', label: 'chat has unread messages' }}
      aside={unread() === 0 ? undefined : () => <Chip>{chatUnreadLabel(unread())}</Chip>}
      priority={TOPBAR_PRIORITY.chat}
      visible={visible()}
      activate={toggle}
    >
      <IconButton
        ref={el => {
          button = el;
        }}
        onClick={toggle}
        id="chat-button"
        active={open()}
        title="Chat"
        aria-label="Chat"
        aria-expanded={open() ? 'true' : 'false'}
        aria-controls="chat-panel"
        hidden={!visible()}
      >
        <ChatIcon size={12} />
        <span class={s['unread']} id="chat-unread-badge" hidden={unread() === 0}>
          {unread() === 0 ? '' : chatUnreadLabel(unread())}
        </span>
      </IconButton>
    </TopbarItem>
  );
}
