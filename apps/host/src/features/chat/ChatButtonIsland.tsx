// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { useStore } from '@dotli/stores-solid';
import { ChatItem } from './ChatButton.js';
import { chatPanelState } from './chatPanelState.js';
import { chatUnreadLabel } from './unread.js';

/** The chat button in the topbar, bound to the page's chat state. */
export function ChatButtonIsland(): JSX.Element {
  // Read here, not in the props, since Solid reads a prop lazily, outside this component.
  const visible = useStore(chatPanelState.store, chatPanelState.isButtonVisible);
  const open = useStore(chatPanelState.store, state => state.open);
  const unread = useStore(chatPanelState.store, state => {
    const total = chatPanelState.getTotalUnread(state);
    // The room rows carry their own counts while the panel is open.
    return state.open || total === 0 ? undefined : chatUnreadLabel(total);
  });
  return (
    <ChatItem
      visible={visible}
      open={open}
      unread={unread}
      onToggle={() => {
        chatPanelState.setOpen(!chatPanelState.store.get().open);
      }}
      handOver={chatPanelState.setTrigger}
    />
  );
}
