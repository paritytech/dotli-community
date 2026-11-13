// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product side of chat. The core checks the product's access before it forwards a call here.

import type { ChatPlatform } from '@parity/truapi-host';
import type { HostChatListSubscribeItem } from '@parity/truapi';
import { chatStore, type ChatStore } from '../chat/createChatStore.js';
import { createResultStream } from './createResultStream.js';
import { followChatRooms } from './followChatRooms.js';

type Params = {
  /** The chat the product's rooms, bots and messages live in. The page's chat store by default. */
  chat?: ChatStore;
};

/**
 * Serves the product side of chat over the chat store. Each call rejects as the store's call does. The room list
 * stream yields one error item when a read fails, and the stream then ends.
 */
export function createChatPlatform({ chat = chatStore }: Params = {}): Required<ChatPlatform> {
  return {
    async createChatRoom(product, request) {
      const status = await chat.createRoom(product.productId, {
        roomId: request.roomId,
        name: request.name,
        icon: request.icon,
      });
      return { status };
    },

    async setChatRoomFooter(product, request) {
      await chat.setRoomFooter({ productId: product.productId, roomId: request.roomId, footer: request.footer });
    },

    async registerChatBot(product, request) {
      const status = await chat.registerBot(product.productId, {
        botId: request.botId,
        name: request.name,
        icon: request.icon,
      });
      return { status };
    },

    async postChatMessage(product, request) {
      const messageId = await chat.postProductMessage({
        productId: product.productId,
        roomId: request.roomId,
        content: request.payload,
      });
      return { messageId };
    },

    subscribeChatRooms(product) {
      return createResultStream<HostChatListSubscribeItem>([], (push, pushError) =>
        followChatRooms({ chat, productId: product.productId, push, pushError }),
      );
    },
  };
}
