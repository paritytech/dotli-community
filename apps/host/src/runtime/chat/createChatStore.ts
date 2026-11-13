// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Product chat is a local conversation with the loaded product, and nothing leaves the device. This store is the
// only writer of chat data, so every write is announced through `subscribe` and shown through `view`. User replies and
// custom-message taps reach the product through its live connection.

import type { ChatMessageContent, HostRendererActionSubscribeItem } from '@parity/truapi';
import { createReporter, defineCount } from '@dotli/metrics';
import { createListenerSet, createRandomId, realTimers, type Timers } from '@dotli/shared';
import {
  chat,
  type ChatBotRecord,
  type ChatMessageRecord,
  type ChatRoomFooter,
  type ChatRoomRecord,
} from '@dotli/storage';
import { ChatReplyUndeliveredError } from './chatReplyUndeliveredError.js';
import { chatConnections, type ChatConnection, type ChatConnections } from './createChatConnections.js';
import { createChatView, type ChatChange, type ChatViewRepo } from './createChatView.js';
import { reportFailedChatStorage } from './reportFailedChatStorage.js';
import { NOT_CONNECTED, startCustomRender, type RenderCustomMessageParams } from './startCustomRender.js';

const report = createReporter({ flow: 'chat' });

/**
 * A user's reply, tap or gesture that could not reach the product, for want of a live connection or as its publish
 * failed. Tagged `outcome` (error) and `reason` (`not_connected`, else the error's name).
 */
const chatPublishMetric = defineCount<'error'>('chat.publish');

type PublishStep = 'chat_reply_publish' | 'chat_action_publish' | 'chat_renderer_action_publish';

export type { ChatBotRecord, ChatMessageRecord, ChatRoomFooter, ChatRoomRecord };

/** Where chat data lives. IndexedDB in the page. Every member rejects when the store fails. */
export type ChatRepo = ChatViewRepo & {
  /** Answers TrUAPI `ChatRoomRegistrationStatus`. A re-creation refreshes the name and icon and keeps the footer. */
  createRoom(room: Omit<ChatRoomRecord, 'createdAt'>): Promise<'New' | 'Exists'>;
  /** Resolves false, writing nothing, when the product has no room with this id. */
  setRoomFooter(params: SetRoomFooterParams): Promise<boolean>;
  /** Answers TrUAPI `ChatBotRegistrationStatus`. A re-registration refreshes the name and icon. */
  registerBot(bot: Omit<ChatBotRecord, 'createdAt'>): Promise<'New' | 'Exists'>;
  /** Resolves the message's `seq` once it is stored. */
  appendMessage(message: Omit<ChatMessageRecord, 'seq'>): Promise<number>;
};

export type ChatStore = ReturnType<typeof createChatStore>;

type Params = {
  /** Where the chat data lives. */
  repo: ChatRepo;
  /** The live product connections a reply, a tap or a render goes through. */
  connections: ChatConnections;
  /** The clock that stamps each stored message. */
  timers?: Pick<Timers, 'now'>;
};

export type SetRoomFooterParams = {
  /** The product that owns the room. */
  productId: string;
  /** The room whose footer changes. */
  roomId: string;
  /** The footer to show from now on. */
  footer: ChatRoomFooter;
};

type PostProductMessageParams = {
  /** The product that posts. */
  productId: string;
  /** The room the message lands in. */
  roomId: string;
  /** The message as the product sent it. */
  content: ChatMessageContent;
};

type PostUserMessageParams = {
  /** The product the user replies to. */
  productId: string;
  /** The room the reply lands in. */
  roomId: string;
  /** The user's reply. */
  text: string;
};

type TriggerActionParams = {
  /** The product that posted the message. */
  productId: string;
  /** The room the message is in. */
  roomId: string;
  /** The message and the action on it the user tapped. */
  trigger: { messageId: string; actionId: string; payload?: `0x${string}` };
};

/**
 * Builds a chat store over `repo` that announces each write it makes and shows the followed view. Building one reads
 * nothing and never throws.
 */
export function createChatStore({ repo, connections, timers = realTimers }: Params) {
  // A broken subscriber must not fail the product's call that made the write.
  const listeners = createListenerSet<ChatChange>({ onListenerError: report.listener('chat_store.change') });
  const chatView = createChatView({ repo });

  function notify(change: ChatChange): void {
    chatView.noteChange(change);
    listeners.emit(change);
  }

  /** The product's live connection. Throws an `Error`, reported, when it has none. */
  function requireConnection(productId: string, step: PublishStep): ChatConnection {
    const connection = connections.get(productId);
    if (connection === undefined) {
      const error = new Error(NOT_CONNECTED);
      report.expected(error, { step, metric: chatPublishMetric, reason: 'not_connected' });
      throw error;
    }
    return connection;
  }

  /** Waits for `published`. Rejects with its failure, reported as the transport's. */
  async function publish(step: PublishStep, published: Promise<void>): Promise<void> {
    try {
      await published;
    } catch (error) {
      report.expected(error, { step, metric: chatPublishMetric });
      throw error;
    }
  }

  return {
    /** The followed product's rooms and the open room's messages, kept current with every write. */
    view: chatView.view,
    /**
     * Points the view at `next`, or at nothing for null, after which a read still running reaches no view and none due
     * after it runs. Idempotent. Never throws: a read that fails shows in the view's failed flags.
     */
    follow: chatView.follow,
    /** Resolves once no view read is queued or running. Never rejects, as a failed read is reported and shown. */
    settle: chatView.settle,

    /**
     * Hears every write, after it is stored, until the returned function unsubscribes. A listener that throws is
     * reported, and the write still succeeds.
     */
    subscribe: listeners.subscribe,

    /**
     * Stores the room and resolves `New` or `Exists`. A repeat for an existing room refreshes its name and icon, so it
     * always notifies. Rejects when the repo fails.
     */
    async createRoom(
      productId: string,
      room: { roomId: string; name: string; icon: string },
    ): Promise<'New' | 'Exists'> {
      const status = await repo.createRoom({ productId, ...room });
      notify({ kind: 'rooms', productId });
      return status;
    },

    /** Rejects for a room the product never created, and when the repo fails. */
    async setRoomFooter({ productId, roomId, footer }: SetRoomFooterParams): Promise<void> {
      if (!(await repo.setRoomFooter({ productId, roomId, footer }))) {
        throw new Error(`No chat room ${roomId}`);
      }
      notify({ kind: 'rooms', productId });
    },

    /**
     * Persisted with its rooms, so a re-registration after reload resolves to `Exists` and refreshes name and icon.
     * Rejects when the repo fails.
     */
    async registerBot(
      productId: string,
      bot: { botId: string; name: string; icon: string },
    ): Promise<'New' | 'Exists'> {
      const status = await repo.registerBot({ productId, ...bot });
      notify({ kind: 'bots', productId });
      return status;
    },

    /** Stores the product's message and resolves its new id. Rejects when the repo fails. */
    async postProductMessage({ productId, roomId, content }: PostProductMessageParams): Promise<string> {
      const messageId = createRandomId();
      await repo.appendMessage({
        productId,
        roomId,
        messageId,
        author: 'product',
        content,
        timestamp: timers.now(),
      });
      notify({ kind: 'message', productId, roomId, author: 'product' });
      return messageId;
    },

    /**
     * Requires a live connection up front, so a reply that cannot reach the product is never stored looking sent.
     * Rejects, with nothing stored, without a live connection and when the repo fails. Rejects with
     * `ChatReplyUndeliveredError` when the stored reply cannot be published. Every failure is reported.
     */
    async postUserMessage({ productId, roomId, text }: PostUserMessageParams): Promise<void> {
      const connection = requireConnection(productId, 'chat_reply_publish');
      const content: ChatMessageContent = { tag: 'Text', value: { text } };
      try {
        await repo.appendMessage({
          productId,
          roomId,
          messageId: createRandomId(),
          author: 'user',
          content,
          timestamp: timers.now(),
        });
      } catch (error) {
        reportFailedChatStorage(error, 'chat_reply_store');
        throw error;
      }
      notify({ kind: 'message', productId, roomId, author: 'user' });
      try {
        await publish(
          'chat_reply_publish',
          connection.publish({ roomId, peer: 'user', payload: { tag: 'MessagePosted', value: content } }),
        );
      } catch (error) {
        throw new ChatReplyUndeliveredError(roomId, error);
      }
    },

    /**
     * Hands the user's tap on a message action to the product. Rejects without a live connection or when it fails,
     * reported.
     */
    async triggerAction({ productId, roomId, trigger }: TriggerActionParams): Promise<void> {
      await publish(
        'chat_action_publish',
        requireConnection(productId, 'chat_action_publish').publish({
          roomId,
          peer: 'user',
          payload: { tag: 'ActionTriggered', value: trigger },
        }),
      );
    },

    /**
     * Hands a gesture inside a custom message's tree to the product. Rejects without a live connection or when it
     * fails, reported.
     */
    async triggerRendererAction(productId: string, item: HostRendererActionSubscribeItem): Promise<void> {
      await publish(
        'chat_renderer_action_publish',
        requireConnection(productId, 'chat_renderer_action_publish').publishRendererAction(item),
      );
    },

    /**
     * Streams trees into `sink` until disposed, on the product's newest connection. A render its connection fails tells
     * the sink, then goes on at once on a newer connection, or on the next one that registers for the product. Without a
     * connection the sink fails at once and the render waits the same way. A completed render is final. Never throws.
     */
    renderCustomMessage({ productId, request, sink }: RenderCustomMessageParams): () => void {
      return startCustomRender({ connections, productId, request, sink });
    },

    /**
     * The product's rooms, in creation order. A failed read is reported, and the call then rejects with the repo's
     * error.
     */
    async listRooms(productId: string): Promise<ChatRoomRecord[]> {
      try {
        return await repo.listRooms(productId);
      } catch (error) {
        reportFailedChatStorage(error, 'chat_rooms_read');
        throw error;
      }
    },
  };
}

/** The page's chat store over IndexedDB. */
export const chatStore = createChatStore({
  repo: {
    createRoom: chat.createRoom,
    setRoomFooter: chat.setRoomFooter,
    registerBot: chat.registerBot,
    appendMessage: chat.appendMessage,
    listRooms: chat.listRooms,
    listBots: chat.listBots,
    readLatestMessageTimestamps: chat.getLatestMessageTimestamps,
    listMessages: chat.listMessages,
  },
  connections: chatConnections,
});
