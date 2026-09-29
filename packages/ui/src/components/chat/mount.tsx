// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Entry of the lazily loaded chat chunk. Only chat/load.ts imports it.

import { mountRoot } from '../../mount/root.js';
import { ChatPanel } from './ChatPanel.js';

export function mountChatPanel(onBroken: () => void): () => void {
  const container = document.getElementById('chat-panel');
  if (container === null) {
    throw new Error('chat panel container is missing');
  }
  return mountRoot('chat', container, () => <ChatPanel />, { onBroken });
}
