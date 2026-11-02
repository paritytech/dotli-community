// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product side of chat. The core checks the product's access before it forwards a call here.

import type { ChatPlatform } from '@parity/truapi-host';
import type { HostChatListSubscribeItem } from '@parity/truapi';
import { createAsyncTaskPool, getErrorMessage, type AsyncTaskPool } from '@dotli/shared';
import { chatStore, type ChatStore } from '../chat/createChatStore.js';
import { createResultStream } from './createResultStream.js';

type Params = {
  /** The chat the product's rooms, bots and messages live in. The page's chat store by default. */
  chat?: ChatStore;
  /**
   * Builds the pool a room list subscription runs its reads on, which must run one task at a time. Called once per
   * subscription. A new one-slot pool by default.
   */
  createReadPool?: () => AsyncTaskPool;
};

/**
 * Serves the product side of chat over the chat store. Each call rejects as the store's call does. The room list
 * stream yields one error item when a read fails, and the stream then ends.
 */
export function createChatPlatform({
  chat = chatStore,
  createReadPool = () => createAsyncTaskPool({ poolSize: 1 }),
}: Params = {}): Required<ChatPlatform> {
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
      return createResultStream<HostChatListSubscribeItem>([], (push, pushError) => {
        // Aborted when the product stops listening, which drops the queued reads and silences the running one.
        const listening = new AbortController();
        const { signal } = listening;
        // One read at a time, so lists land in the order they were read. A change marks the list stale, and the
        // queued read that finds it already fresh does nothing, so a burst of changes costs one more read.
        const reads = createReadPool();
        let stale = false;

        // Read after each wait, since the product can stop listening during any of them.
        function isStopped(): boolean {
          return signal.aborted;
        }

        async function readRooms(): Promise<void> {
          if (!stale) {
            return;
          }
          stale = false;
          try {
            const rooms = await chat.listRooms(product.productId);
            if (!isStopped()) {
              push({ rooms: rooms.map(room => ({ roomId: room.roomId, participatingAs: 'RoomHost' as const })) });
            }
          } catch (error) {
            if (!isStopped()) {
              pushError({ reason: getErrorMessage(error) });
            }
          }
        }

        function refresh(): void {
          stale = true;
          // The close's abort is what the close asked for. A read catches its own failures, so anything else is a
          // fault, and the page's unhandled rejection report carries it.
          void reads.call(readRooms, { signal }).catch((error: unknown) => {
            if (error !== signal.reason) {
              throw error;
            }
          });
        }

        function dispose(): void {
          listening.abort();
          stop();
        }

        const stop = chat.subscribe(change => {
          if (change.kind === 'rooms' && change.productId === product.productId) {
            refresh();
          }
        });
        refresh();
        return dispose;
      });
    },
  };
}
