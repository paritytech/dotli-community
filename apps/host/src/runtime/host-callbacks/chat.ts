// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product side of chat, which the core forwards after its own access check. The user side flows
// the other way, through `publishChatAction` on the worker host runtime.

import type { ChatPlatform } from '@parity/truapi-host';
import type { HostChatListSubscribeItem } from '@parity/truapi';
import { createAsyncTaskPool } from '@dotli/shared';
import { chatStore } from '../chat/chat-store.js';
import type { ChatStore } from '../chat/store.js';
import { createResultStream } from './result-stream.js';

export function createChatPlatform(chat: ChatStore = chatStore): Required<ChatPlatform> {
  return {
    async createChatRoom(product, request) {
      const status = await chat.createRoom(product.productId, {
        roomId: request.roomId,
        name: request.name,
        icon: request.icon,
      });
      return { status };
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
      const messageId = await chat.postProductMessage(product.productId, request.roomId, request.payload);
      return { messageId };
    },

    subscribeChatRooms(product) {
      return createResultStream<HostChatListSubscribeItem>([], (push, pushError) => {
        // Aborted when the product stops listening, which drops the queued reads and silences the running one.
        const listening = new AbortController();
        const { signal } = listening;
        // Read after each wait, since the product can stop listening during any of them.
        const stopped = (): boolean => signal.aborted;
        // One read at a time, so lists land in the order they were read. A change marks the list stale, and the
        // queued read that finds it already fresh does nothing, so a burst of changes costs one more read.
        const reads = createAsyncTaskPool({ poolSize: 1 });
        let stale = false;
        const readRooms = async (): Promise<void> => {
          if (!stale) {
            return;
          }
          stale = false;
          try {
            const rooms = await chat.rooms(product.productId);
            if (!stopped()) {
              push({ rooms: rooms.map(room => ({ roomId: room.roomId, participatingAs: 'RoomHost' as const })) });
            }
          } catch (error) {
            if (!stopped()) {
              pushError({ reason: error instanceof Error ? error.message : String(error) });
            }
          }
        };
        const refresh = (): void => {
          stale = true;
          // The close's abort is what the close asked for. A read catches its own failures, so anything else is a
          // fault, and the page's unhandled rejection report carries it.
          void reads.call(readRooms, { signal }).catch((error: unknown) => {
            if (error !== signal.reason) {
              throw error;
            }
          });
        };
        const stop = chat.subscribe(change => {
          if (change.kind === 'rooms' && change.productId === product.productId) {
            refresh();
          }
        });
        refresh();
        return () => {
          listening.abort();
          stop();
        };
      });
    },
  };
}
