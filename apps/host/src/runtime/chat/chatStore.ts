// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's chat store over IndexedDB.

import {
  appendMessage,
  createRoom,
  latestMessageTimestamps,
  listBots,
  listMessages,
  listRooms,
  registerBot,
  setRoomFooter,
} from '@dotli/storage';
import { createChatConnections, createChatStore } from './store.js';

export const chatConnections = createChatConnections();

export const chatStore = createChatStore({
  repo: {
    createRoom,
    setRoomFooter,
    registerBot,
    appendMessage,
    listRooms,
    listBots,
    latestMessageTimestamps,
    listMessages: (productId, roomId) => listMessages(productId, roomId),
  },
  connections: chatConnections,
});
