// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Product chat is a local conversation with the loaded product, and nothing leaves the device. This store is the
// only writer of chat data, so every write is announced through `subscribe` and shown through `view`. User replies and
// custom-message taps reach the product through its live connection.

import type { ChatMessageContent, HostRendererActionSubscribeItem, ProductRendererRenderRequest } from '@parity/truapi';
import type { RenderSink } from '@parity/truapi-host';
import { reportDefect, reportExpected, reportListener, spans as S } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  createListenerSet,
  createSyncStore,
  createRandomId,
  isShallowEqual,
  realTimers,
  type ReadableStore,
  type Timers,
} from '@dotli/shared';
import {
  chat,
  isExpectedDbError,
  type ChatBotRecord,
  type ChatMessageRecord,
  type ChatRoomFooter,
  type ChatRoomRecord,
} from '@dotli/storage';
import { chatConnections, type ChatConnection, type ChatConnections } from './createChatConnections.js';

export type { ChatBotRecord, ChatMessageRecord, ChatRoomFooter, ChatRoomRecord };

/** Where chat data lives. IndexedDB in the page. Every member rejects when the store fails. */
export type ChatRepo = {
  /** Answers TrUAPI `ChatRoomRegistrationStatus`. A re-creation refreshes the name and icon and keeps the footer. */
  createRoom(room: Omit<ChatRoomRecord, 'createdAt'>): Promise<'New' | 'Exists'>;
  /** Resolves false, writing nothing, when the product has no room with this id. */
  setRoomFooter(params: SetRoomFooterParams): Promise<boolean>;
  /** Answers TrUAPI `ChatBotRegistrationStatus`. A re-registration refreshes the name and icon. */
  registerBot(bot: Omit<ChatBotRecord, 'createdAt'>): Promise<'New' | 'Exists'>;
  /** Resolves the message's `seq` once it is stored. */
  appendMessage(message: Omit<ChatMessageRecord, 'seq'>): Promise<number>;
  /** The product's rooms, in creation order. */
  listRooms(productId: string): Promise<ChatRoomRecord[]>;
  /** The product's bots, in registration order. */
  listBots(productId: string): Promise<ChatBotRecord[]>;
  /** The time of the latest message in each of the product's rooms that has one, by room id. */
  readLatestMessageTimestamps(productId: string): Promise<Map<string, number>>;
  /** The room's messages, in insertion order. */
  listMessages(productId: string, roomId: string): Promise<ChatMessageRecord[]>;
};

/** One write the store made. */
export type ChatChange =
  | { kind: 'rooms'; productId: string }
  | { kind: 'bots'; productId: string }
  | { kind: 'message'; productId: string; roomId: string; author: 'product' | 'user' };

/** What the open panel shows. */
export type ChatFollow = {
  productId: string;
  /** The open conversation, or null for the room list. */
  roomId: string | null;
  /** A reload of the same product reads the room list again, as another tab of it may have written meanwhile. */
  loadId: number;
};

export type ChatContacts = {
  rooms: readonly ChatRoomRecord[];
  bots: readonly ChatBotRecord[];
  lastMessageTimes: ReadonlyMap<string, number>;
};

export type ChatView = {
  productId: string | null;
  /** Null until the product's first room list read lands. */
  contacts: ChatContacts | null;
  /** The last room list read failed. The rooms read before it stay. */
  contactsFailed: boolean;
  roomId: string | null;
  /** Null until the room's first read lands. */
  messages: readonly ChatMessageRecord[] | null;
  messagesFailed: boolean;
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

type RenderCustomMessageParams = {
  /** The product that renders the message. */
  productId: string;
  /** The custom message to render. */
  request: ProductRendererRenderRequest;
  /** Where the trees stream. */
  sink: RenderSink;
};

const NOT_CONNECTED = 'Chat is not connected for this product';

const NO_VIEW: ChatView = {
  productId: null,
  contacts: null,
  contactsFailed: false,
  roomId: null,
  messages: null,
  messagesFailed: false,
};

/**
 * Builds a chat store over `repo` that announces each write it makes and shows the followed view. Building one reads
 * nothing and never throws.
 */
export function createChatStore({ repo, connections, timers = realTimers }: Params) {
  // A broken subscriber must not fail the product's call that made the write.
  const listeners = createListenerSet<ChatChange>({ onListenerError: reportListener('chat', 'chat_store.change') });
  const viewChange = createSyncStore<ChatView>({ name: 'chat_view', initial: NO_VIEW, equals: isShallowEqual });
  const view: ReadableStore<ChatView> = viewChange;
  let target: ChatFollow | null = null;
  // One read of each kind at a time, so results land in the order they were read. A change marks its read stale, and
  // a queued read that finds it fresh does nothing, so a burst of changes costs one more read.
  const reads = createAsyncTaskPool({ poolSize: 1 });
  let contactsStale = false;
  let messagesStale = false;
  // Messages reorder the list, which is re-read for them only while it shows, and once on return if any arrived.
  let listMissedMessages = false;

  function patch(next: Partial<ChatView>): void {
    viewChange.set({ ...viewChange.get(), ...next });
  }

  function reportFailedRead(
    error: unknown,
    step: 'chat_contacts_read' | 'chat_messages_read' | 'chat_rooms_read',
  ): void {
    if (isExpectedDbError(error)) {
      reportExpected(error, { flow: 'chat', step, metric: S.CHAT_READ });
      return;
    }
    reportDefect(error, {
      flow: 'chat',
      step,
      metric: S.CHAT_READ,
      message: `[dot.li chat] ${step} failed:`,
      tags: { kind: 'chat_panel_read_error' },
    });
  }

  // A read for a product or room the panel has since left never reaches the view, but a failure of it is still reported.
  async function readContacts(): Promise<void> {
    if (!contactsStale || target === null) {
      return;
    }
    contactsStale = false;
    const { productId } = target;
    const isCurrent = (): boolean => target?.productId === productId;
    try {
      const [rooms, bots, lastMessageTimes] = await Promise.all([
        repo.listRooms(productId),
        repo.listBots(productId),
        repo.readLatestMessageTimestamps(productId),
      ]);
      if (isCurrent()) {
        patch({ contacts: { rooms, bots, lastMessageTimes }, contactsFailed: false });
      }
    } catch (error) {
      reportFailedRead(error, 'chat_contacts_read');
      if (isCurrent()) {
        patch({ contactsFailed: true });
      }
    }
  }

  async function readMessages(): Promise<void> {
    const following = target;
    const roomId = following?.roomId ?? null;
    if (!messagesStale || following === null || roomId === null) {
      return;
    }
    messagesStale = false;
    const { productId } = following;
    const isCurrent = (): boolean => target?.productId === productId && target.roomId === roomId;
    try {
      const messages = await repo.listMessages(productId, roomId);
      if (isCurrent()) {
        patch({ messages, messagesFailed: false });
      }
    } catch (error) {
      reportFailedRead(error, 'chat_messages_read');
      if (isCurrent()) {
        patch({ messagesFailed: true });
      }
    }
  }

  function refreshContacts(): void {
    contactsStale = true;
    void reads.call(readContacts, { pool: 'contacts' });
  }

  function refreshMessages(): void {
    messagesStale = true;
    void reads.call(readMessages, { pool: 'messages' });
  }

  function followChange(change: ChatChange): void {
    if (target?.productId !== change.productId) {
      return;
    }
    if (change.kind !== 'message' || target.roomId === null) {
      refreshContacts();
      return;
    }
    listMissedMessages = true;
    if (change.roomId === target.roomId) {
      refreshMessages();
    }
  }

  function notify(change: ChatChange): void {
    followChange(change);
    listeners.emit(change);
  }

  function requireConnection(productId: string): ChatConnection {
    const connection = connections.get(productId);
    if (connection === undefined) {
      throw new Error(NOT_CONNECTED);
    }
    return connection;
  }

  return {
    /** The followed product's rooms and the open room's messages, kept current with every write. */
    view,

    /**
     * Points the view at `next`, or at nothing for null, which drops reads still in flight. Idempotent. Never throws: a
     * read that fails shows in the view's failed flags.
     */
    follow(next: ChatFollow | null): void {
      const previous = target;
      if (next === null) {
        target = null;
        contactsStale = false;
        messagesStale = false;
        listMissedMessages = false;
        viewChange.set(NO_VIEW);
        return;
      }
      const sameProduct = previous !== null && previous.productId === next.productId;
      const sameRoom = sameProduct && previous.roomId === next.roomId;
      const reloaded = !sameProduct || previous.loadId !== next.loadId;
      if (sameRoom && !reloaded) {
        return;
      }
      target = next;
      const shown = viewChange.get();
      viewChange.set({
        productId: next.productId,
        contacts: sameProduct ? shown.contacts : null,
        contactsFailed: sameProduct && shown.contactsFailed,
        roomId: next.roomId,
        messages: sameRoom ? shown.messages : null,
        messagesFailed: sameRoom && shown.messagesFailed,
      });
      if (reloaded || (next.roomId === null && listMissedMessages)) {
        listMissedMessages = false;
        refreshContacts();
      }
      if (!sameRoom && next.roomId !== null) {
        refreshMessages();
      }
    },

    /** Resolves once no view read is queued or running. Never rejects, as a failed read is reported and shown. */
    async settle(): Promise<void> {
      await Promise.all([reads.settle('contacts'), reads.settle('messages')]);
    },

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
     * Requires a live connection up front, so a message that cannot reach the product is never stored looking
     * sent. A later publish failure surfaces without losing the stored message. Rejects without a live connection,
     * when the repo fails, and when the publish fails.
     */
    async postUserMessage({ productId, roomId, text }: PostUserMessageParams): Promise<void> {
      const connection = requireConnection(productId);
      const content: ChatMessageContent = { tag: 'Text', value: { text } };
      await repo.appendMessage({
        productId,
        roomId,
        messageId: createRandomId(),
        author: 'user',
        content,
        timestamp: timers.now(),
      });
      notify({ kind: 'message', productId, roomId, author: 'user' });
      await connection.publish({
        roomId,
        peer: 'user',
        payload: { tag: 'MessagePosted', value: content },
      });
    },

    /** Hands the user's tap on a message action to the product. Rejects without a live connection or when it fails. */
    async triggerAction({ productId, roomId, trigger }: TriggerActionParams): Promise<void> {
      await requireConnection(productId).publish({
        roomId,
        peer: 'user',
        payload: { tag: 'ActionTriggered', value: trigger },
      });
    },

    /**
     * Hands a gesture inside a custom message's tree to the product. Rejects without a live connection or when it
     * fails.
     */
    async triggerRendererAction(productId: string, item: HostRendererActionSubscribeItem): Promise<void> {
      await requireConnection(productId).publishRendererAction(item);
    },

    /**
     * Streams replacement trees into `sink` until disposed. Without a live connection the sink fails at once, and
     * the stored message stays for a later render. Never throws.
     */
    renderCustomMessage({ productId, request, sink }: RenderCustomMessageParams): () => void {
      const connection = connections.get(productId);
      if (connection === undefined) {
        sink.onError?.(new Error(NOT_CONNECTED));
        return (): void => undefined;
      }
      return connection.render(request, sink);
    },

    /**
     * The product's rooms, in creation order. A failed read is reported, and the call then rejects with the repo's
     * error.
     */
    async listRooms(productId: string): Promise<ChatRoomRecord[]> {
      try {
        return await repo.listRooms(productId);
      } catch (error) {
        reportFailedRead(error, 'chat_rooms_read');
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
    listMessages: (productId, roomId) => chat.listMessages(productId, roomId),
  },
  connections: chatConnections,
});
