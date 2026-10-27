// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's chat store over IndexedDB.

import { chat } from '@dotli/storage';
import { createChatConnections, createChatStore } from './store.js';

export const chatConnections = createChatConnections();

export const chatStore = createChatStore({
  repo: {
    createRoom: chat.createRoom,
    setRoomFooter: (productId, roomId, footer) => chat.setRoomFooter({ productId, roomId, footer }),
    registerBot: chat.registerBot,
    appendMessage: chat.appendMessage,
    listRooms: chat.listRooms,
    listBots: chat.listBots,
    latestMessageTimestamps: chat.getLatestMessageTimestamps,
    listMessages: (productId, roomId) => chat.listMessages(productId, roomId),
  },
  connections: chatConnections,
});
