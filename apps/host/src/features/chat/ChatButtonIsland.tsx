// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { useStore } from '@dotli/stores-solid';
import { ChatItem } from './ChatButton.js';
import { chatPanelState } from './chatPanelState.js';
import { chatUnreadLabel } from './unread.js';

/** The chat button in the topbar, bound to the page's chat state. */
export function ChatButtonIsland(): JSX.Element {
  return (
    <ChatItem
      visible={useStore(chatPanelState.store, chatPanelState.isButtonVisible)}
      open={useStore(chatPanelState.store, state => state.open)}
      unread={useStore(chatPanelState.store, state => {
        const total = chatPanelState.getTotalUnread(state);
        // The room rows carry their own counts while the panel is open.
        return state.open || total === 0 ? undefined : chatUnreadLabel(total);
      })}
      onToggle={() => {
        chatPanelState.setOpen(!chatPanelState.store.get().open);
      }}
      panel={chatPanelState.getElement}
    />
  );
}
