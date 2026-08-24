// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// ChatPlatform host callbacks: the product side of product chat.
//
// The core forwards `chat.create_room` / `chat.post_message` /
// `chat.list_subscribe` here after enforcing its own access policy (the
// connection must be a Chat-kind execution with an active session). The
// user side of the conversation flows the other way, through
// `publishChatAction` on the worker host runtime; see `../chat/service`.

import type { ChatPlatform } from "@parity/truapi-host";
import type { HostChatListSubscribeItem } from "@parity/truapi";
import {
  CHAT_ROOMS_CHANGED_EVENT,
  chatRooms,
  productCreateRoom,
  productPostMessage,
  registerBot,
} from "../chat/service";
import { createResultStream } from "./result-stream";

export function createChatPlatform(): Required<ChatPlatform> {
  return {
    async createChatRoom(product, request) {
      const status = await productCreateRoom(product.productId, {
        roomId: request.roomId,
        name: request.name,
        icon: request.icon,
      });
      return { status };
    },

    // eslint-disable-next-line @typescript-eslint/require-await -- interface is async; the registry is synchronous localStorage.
    async registerChatBot(product, request) {
      const status = registerBot(product.productId, {
        botId: request.botId,
        name: request.name,
        icon: request.icon,
      });
      return { status };
    },

    async postChatMessage(product, request) {
      const messageId = await productPostMessage(
        product.productId,
        request.roomId,
        request.payload,
      );
      return { messageId };
    },

    subscribeChatRooms(product) {
      const snapshot = async (): Promise<HostChatListSubscribeItem> => ({
        rooms: (await chatRooms(product.productId)).map((room) => ({
          roomId: room.roomId,
          participatingAs: "RoomHost" as const,
        })),
      });
      return createResultStream<HostChatListSubscribeItem>(
        [],
        (push, pushError) => {
          let live = true;
          const emitSnapshot = (): void => {
            snapshot().then(
              (item) => {
                if (live) {
                  push(item);
                }
              },
              (error: unknown) => {
                if (live) {
                  pushError({
                    reason:
                      error instanceof Error ? error.message : String(error),
                  });
                }
              },
            );
          };
          const onRoomsChanged = (event: Event): void => {
            const detail = (event as CustomEvent<{ productId: string }>).detail;
            if (detail.productId === product.productId) {
              emitSnapshot();
            }
          };
          window.addEventListener(CHAT_ROOMS_CHANGED_EVENT, onRoomsChanged);
          emitSnapshot();
          return () => {
            live = false;
            window.removeEventListener(
              CHAT_ROOMS_CHANGED_EVENT,
              onRoomsChanged,
            );
          };
        },
      );
    },
  };
}
