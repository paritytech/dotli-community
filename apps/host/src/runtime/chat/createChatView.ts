// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the open chat panel shows: the followed product's rooms and the open room's messages, read again after each
// write that changes them.

import { createReporter, defineCount } from '@dotli/metrics';
import { createStateMachine, isShallowEqual, type HandlerOf, type MachineTypes, type Transition } from '@dotli/shared';
import type { ChatBotRecord, ChatMessageRecord, ChatRoomRecord } from '@dotli/storage';
import { computed } from 'nanostores';
import { reportFailedChatRead } from './reportFailedChatRead.js';

const report = createReporter({ flow: 'chat' });

/**
 * One chat view transition that threw, after which the view keeps the state its handler emitted. Tagged `outcome`
 * (error) and `reason` (the error's name).
 */
const storeTransitionMetric = defineCount<'error'>('chat.store_transition');

/** The reads the view makes. Every member rejects when the store fails. */
export type ChatViewRepo = {
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

type Params = {
  /** Where the chat data is read from. */
  repo: ChatViewRepo;
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
type ReadPhase = 'idle' | 'reading' | 'rereading';

type Reads = { contacts: ReadPhase; messages: ReadPhase };

/** The reads outlive a follow, so a read still running when the panel follows again is not overlapped by a new one. */
type ViewState =
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
type ReadRequest = { read: 'contacts'; productId: string } | { read: 'messages'; productId: string; roomId: string };

type ViewEvent =
  | { kind: 'followed'; next: ChatFollow | null }
  | { kind: 'changed'; change: ChatChange }
  | { kind: 'contactsRead'; productId: string; contacts: ChatContacts }
  | { kind: 'contactsFailed'; productId: string; error: unknown }
  | { kind: 'messagesRead'; productId: string; roomId: string; messages: ChatMessageRecord[] }
  | { kind: 'messagesFailed'; productId: string; roomId: string; error: unknown };

type ViewEffect =
  | { kind: 'readStarted'; request: ReadRequest }
  | { kind: 'readFailed'; step: 'chat_contacts_read' | 'chat_messages_read'; error: unknown };

type ViewMachine = MachineTypes<ViewState, ViewEvent, ViewEffect>;

type Emits = Pick<Transition<ViewMachine>, 'emitSideEffect'>;

/** Builds the chat panel's view over `repo`. Building one reads nothing and never throws. */
export function createChatView({ repo }: Params) {
  // A read for a product or room the panel has since left never reaches the view, but a failure of it is still reported.
  const handleContactsRead: HandlerOf<ViewMachine, 'unfollowed' | 'following', 'contactsRead'> = (
    state,
    { productId, contacts },
    transition,
  ) => {
    const reads = endRead(state, 'contacts', transition);
    if (state.kind === 'following' && state.follow.productId === productId) {
      transition.emitState({ ...state, reads, view: { ...state.view, contacts, contactsFailed: false } });
      return;
    }
    transition.emitState({ ...state, reads });
  };
  const handleContactsFailed: HandlerOf<ViewMachine, 'unfollowed' | 'following', 'contactsFailed'> = (
    state,
    { productId, error },
    transition,
  ) => {
    transition.emitSideEffect({ kind: 'readFailed', step: 'chat_contacts_read', error });
    const reads = endRead(state, 'contacts', transition);
    if (state.kind === 'following' && state.follow.productId === productId) {
      transition.emitState({ ...state, reads, view: { ...state.view, contactsFailed: true } });
      return;
    }
    transition.emitState({ ...state, reads });
  };
  const handleMessagesRead: HandlerOf<ViewMachine, 'unfollowed' | 'following', 'messagesRead'> = (
    state,
    { productId, roomId, messages },
    transition,
  ) => {
    const reads = endRead(state, 'messages', transition);
    if (state.kind === 'following' && state.follow.productId === productId && state.follow.roomId === roomId) {
      transition.emitState({ ...state, reads, view: { ...state.view, messages, messagesFailed: false } });
      return;
    }
    transition.emitState({ ...state, reads });
  };
  const handleMessagesFailed: HandlerOf<ViewMachine, 'unfollowed' | 'following', 'messagesFailed'> = (
    state,
    { productId, roomId, error },
    transition,
  ) => {
    transition.emitSideEffect({ kind: 'readFailed', step: 'chat_messages_read', error });
    const reads = endRead(state, 'messages', transition);
    if (state.kind === 'following' && state.follow.productId === productId && state.follow.roomId === roomId) {
      transition.emitState({ ...state, reads, view: { ...state.view, messagesFailed: true } });
      return;
    }
    transition.emitState({ ...state, reads });
  };
  const machine = createStateMachine<ViewMachine>({
    initial: { kind: 'unfollowed', reads: { contacts: 'idle', messages: 'idle' } },
    handlers: {
      unfollowed: {
        followed(state, { next }, transition) {
          if (next === null) {
            return;
          }
          const withContacts = askRead(state.reads, getReadRequest(next, 'contacts'), transition);
          transition.emitState({
            kind: 'following',
            follow: next,
            view: { ...NO_VIEW, productId: next.productId, roomId: next.roomId },
            missedMessages: false,
            reads: askRead(withContacts, getReadRequest(next, 'messages'), transition),
          });
        },
        contactsRead: handleContactsRead,
        contactsFailed: handleContactsFailed,
        messagesRead: handleMessagesRead,
        messagesFailed: handleMessagesFailed,
      },
      following: {
        followed(state, { next }, transition) {
          if (next === null) {
            transition.emitState({ kind: 'unfollowed', reads: state.reads });
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
          const withContacts = readsContacts
            ? askRead(state.reads, getReadRequest(next, 'contacts'), transition)
            : state.reads;
          transition.emitState({
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
            reads: sameRoom ? withContacts : askRead(withContacts, getReadRequest(next, 'messages'), transition),
          });
        },
        // Messages reorder the list, which is re-read for them only while it shows, and once on return if any arrived.
        changed(state, { change }, transition) {
          const { follow } = state;
          if (change.productId !== follow.productId) {
            return;
          }
          if (change.kind !== 'message' || follow.roomId === null) {
            transition.emitState({
              ...state,
              reads: askRead(state.reads, getReadRequest(follow, 'contacts'), transition),
            });
            return;
          }
          transition.emitState({
            ...state,
            missedMessages: true,
            reads:
              change.roomId === follow.roomId
                ? askRead(state.reads, getReadRequest(follow, 'messages'), transition)
                : state.reads,
          });
        },
        contactsRead: handleContactsRead,
        contactsFailed: handleContactsFailed,
        messagesRead: handleMessagesRead,
        messagesFailed: handleMessagesFailed,
      },
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'readStarted':
          machine.update(runRead(effect.request));
          return;
        case 'readFailed':
          reportFailedChatRead(effect.error, effect.step);
          return;
      }
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

  return {
    /** The followed product's rooms and the open room's messages, kept current with every write. */
    view,
    /**
     * Points the view at `next`, or at nothing for null, after which a read still running reaches no view and none due
     * after it runs. Idempotent. Never throws: a read that fails shows in the view's failed flags.
     */
    follow,
    /** Resolves once no view read is queued or running. Never rejects, as a failed read is reported and shown. */
    settle,
    /** Hears a write the store made, which reads again what it changed on screen. Never throws. */
    noteChange,
  };

  function follow(next: ChatFollow | null): void {
    machine.update({ kind: 'followed', next });
  }

  function settle(): Promise<void> {
    return machine.await();
  }

  function noteChange(change: ChatChange): void {
    machine.update({ kind: 'changed', change });
  }

  /** Reads what `request` names, ending in the event that carries the result or the failure. */
  function runRead(request: ReadRequest): Promise<ViewEvent> {
    const { productId } = request;
    switch (request.read) {
      case 'contacts':
        return Promise.all([
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
        );
      case 'messages': {
        const { roomId } = request;
        return repo.listMessages(productId, roomId).then(
          messages => ({ kind: 'messagesRead', productId, roomId, messages }),
          (error: unknown) => ({ kind: 'messagesFailed', productId, roomId, error }),
        );
      }
    }
  }
}

/** The reads with `request` asked for: started when none of its kind runs, and due after the one that does. */
function askRead(reads: Reads, request: ReadRequest | null, { emitSideEffect }: Emits): Reads {
  if (request === null) {
    return reads;
  }
  switch (reads[request.read]) {
    case 'idle':
      emitSideEffect({ kind: 'readStarted', request });
      return { ...reads, [request.read]: 'reading' };
    case 'reading':
    case 'rereading':
      return { ...reads, [request.read]: 'rereading' };
  }
}

/** The reads with the one of kind `read` ended, and the read due after it started for what `state` follows now. */
function endRead(state: ViewState, read: keyof Reads, { emitSideEffect }: Emits): Reads {
  const request = getReadRequest(state.kind === 'following' ? state.follow : null, read);
  if (state.reads[read] === 'rereading' && request !== null) {
    emitSideEffect({ kind: 'readStarted', request });
    return { ...state.reads, [read]: 'reading' };
  }
  return { ...state.reads, [read]: 'idle' };
}

/** The read of kind `read` that `follow` shows, or null when it shows none. */
function getReadRequest(follow: ChatFollow | null, read: keyof Reads): ReadRequest | null {
  if (follow === null) {
    return null;
  }
  switch (read) {
    case 'contacts':
      return { read, productId: follow.productId };
    case 'messages':
      return follow.roomId === null ? null : { read, productId: follow.productId, roomId: follow.roomId };
  }
}
