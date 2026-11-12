// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Product chat is a local conversation with the loaded product, and nothing leaves the device. This store is the
// only writer of chat data, so every write is announced through `subscribe` and shown through `view`. User replies and
// custom-message taps reach the product through its live connection.

import type { ChatMessageContent, HostRendererActionSubscribeItem } from '@parity/truapi';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createListenerSet,
  createRandomId,
  createStateMachine,
  isShallowEqual,
  nest,
  realTimers,
  type HandlerOf,
  type MachineTypes,
  type Timers,
  type Transition,
} from '@dotli/shared';
import {
  chat,
  isExpectedDbError,
  type ChatBotRecord,
  type ChatMessageRecord,
  type ChatRoomFooter,
  type ChatRoomRecord,
} from '@dotli/storage';
import { computed } from 'nanostores';
import { chatConnections, type ChatConnection, type ChatConnections } from './createChatConnections.js';
import { NOT_CONNECTED, startCustomRender, type RenderCustomMessageParams } from './startCustomRender.js';

const report = createReporter({ flow: 'chat' });

/**
 * One failed read of the chat store: the panel's contacts or messages, after which the panel keeps its last view, or
 * a product's room list, which then rejects to its caller. Tagged `outcome` (error) and `reason` (the error's name).
 */
const chatReadMetric = defineCount<'error'>('chat.read');

/**
 * One chat store transition that threw, after which the store keeps the state its handler emitted. Tagged `outcome`
 * (error) and `reason` (the error's name).
 */
const storeTransitionMetric = defineCount<'error'>('chat.store_transition');

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

const NO_VIEW: ChatView = {
  productId: null,
  contacts: null,
  contactsFailed: false,
  roomId: null,
  messages: null,
  messagesFailed: false,
};

/**
 * One kind of read: none running, one running, or one running with another due after it. One read of each kind at a
 * time, so results land in the order they were read, and a burst of changes during a read costs one more read.
 */
type ReadPhase = { kind: 'idle' } | { kind: 'reading' } | { kind: 'rereading' };

type Reads = { contacts: ReadPhase; messages: ReadPhase };

/** The reads outlive a follow, so a read still running when the panel follows again is not overlapped by a new one. */
type ChatState =
  | { kind: 'unfollowed'; reads: Reads }
  | {
      kind: 'following';
      follow: ChatFollow;
      view: ChatView;
      /** Messages arrived while the room list was off screen, so a return to it reads it again. */
      missedMessages: boolean;
      reads: Reads;
    };

/** A read to run: the product's room list, or the messages of one of its rooms. */
type ReadRequest =
  | { read: 'contacts'; target: { productId: string } }
  | { read: 'messages'; target: { productId: string; roomId: string } };

type ChatEvent =
  | { kind: 'followed'; next: ChatFollow | null }
  | { kind: 'changed'; change: ChatChange }
  | ({ kind: 'readAsked' } & ReadRequest)
  // The read due after the one that ended, or a `null` target when nothing followed has one to read.
  | ({ kind: 'readEnded' } & (ReadRequest | { read: keyof Reads; target: null }))
  | { kind: 'contactsRead'; productId: string; contacts: ChatContacts }
  | { kind: 'contactsFailed'; productId: string; error: unknown }
  | { kind: 'messagesRead'; productId: string; roomId: string; messages: ChatMessageRecord[] }
  | { kind: 'messagesFailed'; productId: string; roomId: string; error: unknown };

type ChatEffect = { kind: 'readFailed'; step: 'chat_contacts_read' | 'chat_messages_read'; error: unknown };

type ChatMachine = MachineTypes<ChatState, ChatEvent, ChatEffect>;

type ReadMachine = MachineTypes<ReadPhase, ChatEvent>;

/**
 * Builds a chat store over `repo` that announces each write it makes and shows the followed view. Building one reads
 * nothing and never throws.
 */
export function createChatStore({ repo, connections, timers = realTimers }: Params) {
  // A broken subscriber must not fail the product's call that made the write.
  const listeners = createListenerSet<ChatChange>({ onListenerError: report.listener('chat_store.change') });
  const handleRead = nest<ChatMachine, 'unfollowed' | 'following', ReadMachine, 'readAsked' | 'readEnded'>({
    find: ({ reads }, { read }) => reads[read],
    store: (state, { read }, next) => ({ ...state, reads: { ...state.reads, [read]: next } }),
    handlers: {
      idle: {
        readAsked(_phase, request, transition) {
          startRead(request, transition);
        },
      },
      reading: {
        readAsked(_phase, _event, { emitState }) {
          emitState({ kind: 'rereading' });
        },
        readEnded(_phase, _event, { emitState }) {
          emitState({ kind: 'idle' });
        },
      },
      rereading: {
        readEnded(_phase, request, transition) {
          if (request.target === null) {
            transition.emitState({ kind: 'idle' });
            return;
          }
          startRead(request, transition);
        },
      },
    },
  });
  // A read for a product or room the panel has since left never reaches the view, but a failure of it is still reported.
  const handleContactsRead: HandlerOf<ChatMachine, 'unfollowed' | 'following', 'contactsRead'> = (
    state,
    { productId, contacts },
    { emitState, update },
  ) => {
    if (state.kind === 'following' && state.follow.productId === productId) {
      emitState({ ...state, view: { ...state.view, contacts, contactsFailed: false } });
    }
    update(getContactsReadEnd(state));
  };
  const handleContactsFailed: HandlerOf<ChatMachine, 'unfollowed' | 'following', 'contactsFailed'> = (
    state,
    { productId, error },
    { emitState, emitSideEffect, update },
  ) => {
    if (state.kind === 'following' && state.follow.productId === productId) {
      emitState({ ...state, view: { ...state.view, contactsFailed: true } });
    }
    emitSideEffect({ kind: 'readFailed', step: 'chat_contacts_read', error });
    update(getContactsReadEnd(state));
  };
  const handleMessagesRead: HandlerOf<ChatMachine, 'unfollowed' | 'following', 'messagesRead'> = (
    state,
    { productId, roomId, messages },
    { emitState, update },
  ) => {
    if (state.kind === 'following' && state.follow.productId === productId && state.follow.roomId === roomId) {
      emitState({ ...state, view: { ...state.view, messages, messagesFailed: false } });
    }
    update(getMessagesReadEnd(state));
  };
  const handleMessagesFailed: HandlerOf<ChatMachine, 'unfollowed' | 'following', 'messagesFailed'> = (
    state,
    { productId, roomId, error },
    { emitState, emitSideEffect, update },
  ) => {
    if (state.kind === 'following' && state.follow.productId === productId && state.follow.roomId === roomId) {
      emitState({ ...state, view: { ...state.view, messagesFailed: true } });
    }
    emitSideEffect({ kind: 'readFailed', step: 'chat_messages_read', error });
    update(getMessagesReadEnd(state));
  };
  const machine = createStateMachine<ChatMachine>({
    initial: { kind: 'unfollowed', reads: { contacts: { kind: 'idle' }, messages: { kind: 'idle' } } },
    handlers: {
      unfollowed: {
        followed(state, { next }, { emitState, update }) {
          if (next === null) {
            return;
          }
          emitState({
            kind: 'following',
            follow: next,
            view: { ...NO_VIEW, productId: next.productId, roomId: next.roomId },
            missedMessages: false,
            reads: state.reads,
          });
          update({ kind: 'readAsked', read: 'contacts', target: next });
          if (next.roomId !== null) {
            update({ kind: 'readAsked', read: 'messages', target: { productId: next.productId, roomId: next.roomId } });
          }
        },
        readAsked: handleRead,
        readEnded: handleRead,
        contactsRead: handleContactsRead,
        contactsFailed: handleContactsFailed,
        messagesRead: handleMessagesRead,
        messagesFailed: handleMessagesFailed,
      },
      following: {
        followed(state, { next }, { emitState, update }) {
          if (next === null) {
            emitState({ kind: 'unfollowed', reads: state.reads });
            return;
          }
          const { follow: previous, view: shown } = state;
          const sameProduct = previous.productId === next.productId;
          const sameRoom = sameProduct && previous.roomId === next.roomId;
          const reloaded = !sameProduct || previous.loadId !== next.loadId;
          if (sameRoom && !reloaded) {
            return;
          }
          const readsContacts = reloaded || (next.roomId === null && state.missedMessages);
          emitState({
            ...state,
            follow: next,
            view: {
              productId: next.productId,
              contacts: sameProduct ? shown.contacts : null,
              contactsFailed: sameProduct && shown.contactsFailed,
              roomId: next.roomId,
              messages: sameRoom ? shown.messages : null,
              messagesFailed: sameRoom && shown.messagesFailed,
            },
            missedMessages: state.missedMessages && !readsContacts,
          });
          if (readsContacts) {
            update({ kind: 'readAsked', read: 'contacts', target: next });
          }
          if (!sameRoom && next.roomId !== null) {
            update({ kind: 'readAsked', read: 'messages', target: { productId: next.productId, roomId: next.roomId } });
          }
        },
        // Messages reorder the list, which is re-read for them only while it shows, and once on return if any arrived.
        changed(state, { change }, { emitState, update }) {
          const { follow } = state;
          if (change.productId !== follow.productId) {
            return;
          }
          if (change.kind !== 'message' || follow.roomId === null) {
            update({ kind: 'readAsked', read: 'contacts', target: follow });
            return;
          }
          emitState({ ...state, missedMessages: true });
          if (change.roomId === follow.roomId) {
            update({
              kind: 'readAsked',
              read: 'messages',
              target: { productId: follow.productId, roomId: follow.roomId },
            });
          }
        },
        readAsked: handleRead,
        readEnded: handleRead,
        contactsRead: handleContactsRead,
        contactsFailed: handleContactsFailed,
        messagesRead: handleMessagesRead,
        messagesFailed: handleMessagesFailed,
      },
    },
    onEffect: ({ step, error }) => {
      reportFailedRead(error, step);
    },
    onError: error => {
      report.defect(error, {
        step: 'store_transition',
        metric: storeTransitionMetric,
        message: '[dot.li chat] A chat store transition threw',
      });
    },
  });
  const view = computed(machine.state, current => (current.kind === 'following' ? current.view : NO_VIEW));
  view.eq = isShallowEqual;

  function reportFailedRead(
    error: unknown,
    step: 'chat_contacts_read' | 'chat_messages_read' | 'chat_rooms_read',
  ): void {
    if (isExpectedDbError(error)) {
      report.expected(error, { step, metric: chatReadMetric });
      return;
    }
    report.defect(error, {
      step,
      metric: chatReadMetric,
      message: `[dot.li chat] ${step} failed:`,
      tags: { kind: 'chat_panel_read_error' },
    });
  }

  function startRead(request: ReadRequest, { emitState, update }: Transition<ReadMachine>): void {
    emitState({ kind: 'reading' });
    switch (request.read) {
      case 'contacts': {
        const { productId } = request.target;
        update(
          Promise.all([
            repo.listRooms(productId),
            repo.listBots(productId),
            repo.readLatestMessageTimestamps(productId),
          ]).then(
            ([rooms, bots, lastMessageTimes]) => ({
              kind: 'contactsRead',
              productId,
              contacts: { rooms, bots, lastMessageTimes },
            }),
            (error: unknown) => ({ kind: 'contactsFailed', productId, error }),
          ),
        );
        return;
      }
      case 'messages': {
        const { productId, roomId } = request.target;
        update(
          repo.listMessages(productId, roomId).then(
            messages => ({ kind: 'messagesRead', productId, roomId, messages }),
            (error: unknown) => ({ kind: 'messagesFailed', productId, roomId, error }),
          ),
        );
        return;
      }
    }
  }

  function notify(change: ChatChange): void {
    machine.update({ kind: 'changed', change });
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
     * Points the view at `next`, or at nothing for null, after which a read still running reaches no view and none due after it runs. Idempotent. Never throws: a
     * read that fails shows in the view's failed flags.
     */
    follow(next: ChatFollow | null): void {
      machine.update({ kind: 'followed', next });
    },

    /** Resolves once no view read is queued or running. Never rejects, as a failed read is reported and shown. */
    settle(): Promise<void> {
      return machine.await();
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

/** Ends a room list read, naming the one due next: the followed product's, or none. */
function getContactsReadEnd(state: ChatState): ChatEvent {
  switch (state.kind) {
    case 'unfollowed':
      return { kind: 'readEnded', read: 'contacts', target: null };
    case 'following':
      return { kind: 'readEnded', read: 'contacts', target: state.follow };
  }
}

/** Ends a conversation read, naming the one due next: the open room's, or none. */
function getMessagesReadEnd(state: ChatState): ChatEvent {
  if (state.kind === 'unfollowed' || state.follow.roomId === null) {
    return { kind: 'readEnded', read: 'messages', target: null };
  }
  return {
    kind: 'readEnded',
    read: 'messages',
    target: { productId: state.follow.productId, roomId: state.follow.roomId },
  };
}
