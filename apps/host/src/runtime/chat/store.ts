// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Product chat is a local conversation with the loaded product, and nothing leaves the device. This store is the
// only writer of chat data, so every write reaches the room list stream through `subscribe` and the open panel
// through `view`. User replies and custom-message taps go back through the worker host runtime's action streams.

import type {
  ChatMessageContent,
  HostChatActionSubscribeItem,
  HostRendererActionSubscribeItem,
  ProductRendererRenderRequest,
} from '@parity/truapi';
import type { RenderSink } from '@parity/truapi-host';
import { captureException, recordExpected, reportListener } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  createListenerSet,
  createSyncStore,
  randomId,
  shallowEqual,
  type ReadableStore,
} from '@dotli/shared';
import {
  isExpectedDbError,
  type ChatBotRecord,
  type ChatMessageRecord,
  type ChatRoomFooter,
  type ChatRoomRecord,
} from '@dotli/storage';

export type { ChatBotRecord, ChatMessageRecord, ChatRoomFooter, ChatRoomRecord };

/** Where chat data lives. IndexedDB in the page. */
export interface ChatRepo {
  /** Answers TrUAPI `ChatRoomRegistrationStatus`. A re-creation refreshes the name and icon and keeps the footer. */
  createRoom(room: Omit<ChatRoomRecord, 'createdAt'>): Promise<'New' | 'Exists'>;
  /** False when the product has no room with this id. */
  setRoomFooter(productId: string, roomId: string, footer: ChatRoomFooter): Promise<boolean>;
  registerBot(bot: Omit<ChatBotRecord, 'createdAt'>): Promise<'New' | 'Exists'>;
  appendMessage(message: Omit<ChatMessageRecord, 'seq'>): Promise<number>;
  /** In creation order. */
  listRooms(productId: string): Promise<ChatRoomRecord[]>;
  /** In registration order. */
  listBots(productId: string): Promise<ChatBotRecord[]>;
  latestMessageTimestamps(productId: string): Promise<Map<string, number>>;
  /** In insertion order. */
  listMessages(productId: string, roomId: string): Promise<ChatMessageRecord[]>;
}

/** Live handles for one product's Worker-kind core connection. */
export interface ChatConnection {
  publish(action: HostChatActionSubscribeItem): Promise<void>;
  publishRendererAction(item: HostRendererActionSubscribeItem): Promise<void>;
  render(request: ProductRendererRenderRequest, sink: RenderSink): () => void;
}

export interface ChatConnections {
  /** A stale unregister, after a newer registration for the same product, is a no-op. */
  register(productId: string, connection: ChatConnection): () => void;
  get(productId: string): ChatConnection | undefined;
}

export function createChatConnections(): ChatConnections {
  const connections = new Map<string, ChatConnection>();
  return {
    register(productId, connection) {
      connections.set(productId, connection);
      return () => {
        if (connections.get(productId) === connection) {
          connections.delete(productId);
        }
      };
    },
    get: productId => connections.get(productId),
  };
}

/** One write the store made. */
export type ChatChange =
  | { kind: 'rooms'; productId: string }
  | { kind: 'bots'; productId: string }
  | { kind: 'message'; productId: string; roomId: string; author: 'product' | 'user' };

/** What the open panel shows. */
export interface ChatFollow {
  productId: string;
  /** The open conversation, or null for the room list. */
  roomId: string | null;
  /** A reload of the same product reads the room list again, as another tab of it may have written meanwhile. */
  loadId: number;
}

export interface ChatContacts {
  rooms: readonly ChatRoomRecord[];
  bots: readonly ChatBotRecord[];
  lastMessageTimes: ReadonlyMap<string, number>;
}

export interface ChatView {
  productId: string | null;
  /** Null until the product's first room list read lands. */
  contacts: ChatContacts | null;
  /** The last room list read failed. The rooms read before it stay. */
  contactsFailed: boolean;
  roomId: string | null;
  /** Null until the room's first read lands. */
  messages: readonly ChatMessageRecord[] | null;
  messagesFailed: boolean;
}

export interface ChatStore {
  /** The followed product's rooms and the open room's messages, kept current with every write. */
  view: ReadableStore<ChatView>;
  /** Idempotent. Null when the panel closes, which drops reads still in flight. */
  follow(target: ChatFollow | null): void;
  /** Resolves once no view read is queued or running. */
  settle(): Promise<void>;
  /** Hears every write, after it is stored. */
  subscribe(listener: (change: ChatChange) => void): () => void;
  /** A repeat for an existing room refreshes its name and icon, so it always notifies. */
  createRoom(productId: string, room: { roomId: string; name: string; icon: string }): Promise<'New' | 'Exists'>;
  /** Rejects for a room the product never created. */
  setRoomFooter(productId: string, roomId: string, footer: ChatRoomFooter): Promise<void>;
  /** Persisted with its rooms, so a re-registration after reload resolves to `Exists` and refreshes name and icon. */
  registerBot(productId: string, bot: { botId: string; name: string; icon: string }): Promise<'New' | 'Exists'>;
  postProductMessage(productId: string, roomId: string, content: ChatMessageContent): Promise<string>;
  /**
   * Requires a live connection up front, so a message that cannot reach the product is never stored looking
   * sent. A later publish failure surfaces without losing the stored message.
   */
  postUserMessage(productId: string, roomId: string, text: string): Promise<void>;
  triggerAction(
    productId: string,
    roomId: string,
    trigger: { messageId: string; actionId: string; payload?: `0x${string}` },
  ): Promise<void>;
  triggerRendererAction(productId: string, item: HostRendererActionSubscribeItem): Promise<void>;
  /**
   * Streams replacement trees into `sink` until disposed. Without a live connection the sink fails at once, and
   * the stored message stays for a later render.
   */
  renderCustomMessage(productId: string, request: ProductRendererRenderRequest, sink: RenderSink): () => void;
  rooms(productId: string): Promise<ChatRoomRecord[]>;
}

export interface ChatStoreDeps {
  repo: ChatRepo;
  connections: ChatConnections;
}

const NOT_CONNECTED = 'Chat is not connected for this product';

const NO_VIEW: ChatView = {
  productId: null,
  contacts: null,
  contactsFailed: false,
  roomId: null,
  messages: null,
  messagesFailed: false,
};

export function createChatStore({ repo, connections }: ChatStoreDeps): ChatStore {
  // A broken subscriber must not fail the product's call that made the write.
  const listeners = createListenerSet<ChatChange>({ onListenerError: reportListener('chat', 'chat_store.change') });
  const view = createSyncStore<ChatView>('chat_view', NO_VIEW, { equals: shallowEqual });
  let target: ChatFollow | null = null;
  // One read of each kind at a time, so results land in the order they were read. A change marks its read stale, and
  // a queued read that finds it fresh does nothing, so a burst of changes costs one more read.
  const reads = createAsyncTaskPool({ poolSize: 1 });
  let contactsStale = false;
  let messagesStale = false;
  // Messages reorder the list, which is re-read for them only while it shows, and once on return if any arrived.
  let listMissedMessages = false;

  const patch = (next: Partial<ChatView>): void => {
    view.set({ ...view.get(), ...next });
  };

  const failedRead = (error: unknown, step: 'chat_contacts_read' | 'chat_messages_read'): void => {
    if (isExpectedDbError(error)) {
      recordExpected(error, { flow: 'chat', step });
    } else {
      captureException(error, { flow: 'chat', step, tags: { kind: 'chat_panel_read_error' } });
    }
  };

  // A read for a product or room the panel has since left never reaches the view, but a failure of it is still reported.
  const readContacts = async (): Promise<void> => {
    if (!contactsStale || target === null) {
      return;
    }
    contactsStale = false;
    const { productId } = target;
    const current = (): boolean => target?.productId === productId;
    try {
      const [rooms, bots, lastMessageTimes] = await Promise.all([
        repo.listRooms(productId),
        repo.listBots(productId),
        repo.latestMessageTimestamps(productId),
      ]);
      if (current()) {
        patch({ contacts: { rooms, bots, lastMessageTimes }, contactsFailed: false });
      }
    } catch (error) {
      failedRead(error, 'chat_contacts_read');
      if (current()) {
        patch({ contactsFailed: true });
      }
    }
  };

  const readMessages = async (): Promise<void> => {
    const following = target;
    const roomId = following?.roomId ?? null;
    if (!messagesStale || following === null || roomId === null) {
      return;
    }
    messagesStale = false;
    const { productId } = following;
    const current = (): boolean => target?.productId === productId && target.roomId === roomId;
    try {
      const messages = await repo.listMessages(productId, roomId);
      if (current()) {
        patch({ messages, messagesFailed: false });
      }
    } catch (error) {
      failedRead(error, 'chat_messages_read');
      if (current()) {
        patch({ messagesFailed: true });
      }
    }
  };

  const refreshContacts = (): void => {
    contactsStale = true;
    void reads.call(readContacts, { pool: 'contacts' });
  };

  const refreshMessages = (): void => {
    messagesStale = true;
    void reads.call(readMessages, { pool: 'messages' });
  };

  const followChange = (change: ChatChange): void => {
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
  };

  const notify = (change: ChatChange): void => {
    followChange(change);
    listeners.emit(change);
  };

  const connected = (productId: string): ChatConnection => {
    const connection = connections.get(productId);
    if (connection === undefined) {
      throw new Error(NOT_CONNECTED);
    }
    return connection;
  };

  return {
    view,

    follow(next) {
      const previous = target;
      if (next === null) {
        target = null;
        contactsStale = false;
        messagesStale = false;
        listMissedMessages = false;
        view.set(NO_VIEW);
        return;
      }
      const sameProduct = previous !== null && previous.productId === next.productId;
      const sameRoom = sameProduct && previous.roomId === next.roomId;
      const reloaded = !sameProduct || previous.loadId !== next.loadId;
      if (sameRoom && !reloaded) {
        return;
      }
      target = next;
      const shown = view.get();
      view.set({
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

    async settle() {
      await Promise.all([reads.settle('contacts'), reads.settle('messages')]);
    },

    subscribe: listeners.subscribe,

    async createRoom(productId, room) {
      const status = await repo.createRoom({ productId, ...room });
      notify({ kind: 'rooms', productId });
      return status;
    },

    async setRoomFooter(productId, roomId, footer) {
      if (!(await repo.setRoomFooter(productId, roomId, footer))) {
        throw new Error(`No chat room ${roomId}`);
      }
      notify({ kind: 'rooms', productId });
    },

    async registerBot(productId, bot) {
      const status = await repo.registerBot({ productId, ...bot });
      notify({ kind: 'bots', productId });
      return status;
    },

    async postProductMessage(productId, roomId, content) {
      const messageId = randomId();
      await repo.appendMessage({
        productId,
        roomId,
        messageId,
        author: 'product',
        content,
        timestamp: Date.now(),
      });
      notify({ kind: 'message', productId, roomId, author: 'product' });
      return messageId;
    },

    async postUserMessage(productId, roomId, text) {
      const connection = connected(productId);
      const content: ChatMessageContent = { tag: 'Text', value: { text } };
      await repo.appendMessage({
        productId,
        roomId,
        messageId: randomId(),
        author: 'user',
        content,
        timestamp: Date.now(),
      });
      notify({ kind: 'message', productId, roomId, author: 'user' });
      await connection.publish({
        roomId,
        peer: 'user',
        payload: { tag: 'MessagePosted', value: content },
      });
    },

    async triggerAction(productId, roomId, trigger) {
      await connected(productId).publish({
        roomId,
        peer: 'user',
        payload: { tag: 'ActionTriggered', value: trigger },
      });
    },

    async triggerRendererAction(productId, item) {
      await connected(productId).publishRendererAction(item);
    },

    renderCustomMessage(productId, request, sink) {
      const connection = connections.get(productId);
      if (connection === undefined) {
        sink.onError?.(new Error(NOT_CONNECTED));
        return (): void => undefined;
      }
      return connection.render(request, sink);
    },

    rooms: productId => repo.listRooms(productId),
  };
}
