// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the open chat panel shows: the followed product's rooms and the open room's messages, read again after each
// write that changes them.

import { createReporter, defineCount } from '@dotli/metrics';
import { createStateMachine, isShallowEqual, type MachineTypes, type Transition } from '@dotli/shared';
import type { ChatMessageRecord, ChatRoomRecord } from '@dotli/storage';
import { computed } from 'nanostores';
import { reportFailedChatStorage } from './reportFailedChatStorage.js';

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
  /** The time of the latest message in each of the product's rooms that has one, by room id. */
  readLatestMessageTimestamps(productId: string): Promise<Map<string, number>>;
  /** The room's latest messages, in insertion order. */
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
  /**
   * A reload of the same product reads the room list and the open conversation again, as another tab of it may have
   * written meanwhile.
   */
  loadId: number;
};

export type ChatContacts = {
  rooms: readonly ChatRoomRecord[];
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

/** What the panel shows of the product and room it follows. */
type ChatShown = Pick<ChatView, 'contacts' | 'contactsFailed' | 'messages' | 'messagesFailed'>;

const NO_SHOWN: ChatShown = { contacts: null, contactsFailed: false, messages: null, messagesFailed: false };

const NO_VIEW: ChatView = { productId: null, roomId: null, ...NO_SHOWN };

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
      shown: ChatShown;
      /** Messages arrived while the room list was off screen, so a return to it reads it again. */
      missedMessages: boolean;
      reads: Reads;
    };

/** A read to run: the product's room list, or the messages of one of its rooms. */
type ReadRequest = { read: 'contacts'; productId: string } | { read: 'messages'; productId: string; roomId: string };

/** What a read shows, while the panel still shows what it read. */
type ReadShown = Partial<ChatShown>;

/** Why a read failed, reported under its step. */
type ReadFailure = { step: 'chat_contacts_read' | 'chat_messages_read'; error: unknown };

type ViewEvent =
  | { kind: 'followed'; next: ChatFollow | null }
  | { kind: 'changed'; change: ChatChange }
  | { kind: 'readEnded'; request: ReadRequest; shown: ReadShown; failure: ReadFailure | null };

type ViewEffect = { kind: 'readFailed'; failure: ReadFailure };

type ViewMachine = MachineTypes<ViewState, ViewEvent, ViewEffect>;

type GetFollowShownParams = {
  /** Whether the next follow stays on the shown product. */
  sameProduct: boolean;
  /** Whether the next follow stays in the shown room. */
  sameRoom: boolean;
};

/** What a failed read of each kind shows, and the step it is reported under. */
const READ_FAILURES = {
  contacts: { shown: { contactsFailed: true }, step: 'chat_contacts_read' },
  messages: { shown: { messagesFailed: true }, step: 'chat_messages_read' },
} satisfies Record<ReadRequest['read'], { shown: ReadShown; step: ReadFailure['step'] }>;

/** Builds the chat panel's view over `repo`. Building one reads nothing and never throws. */
export function createChatView({ repo }: Params) {
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
            shown: NO_SHOWN,
            missedMessages: false,
            reads: askRead(withContacts, getReadRequest(next, 'messages'), transition),
          });
        },
        // No follow shows the read and none is due after it. A failure is still reported.
        readEnded(state, { request, failure }, { emitState, emitSideEffect }) {
          emitState({ ...state, reads: { ...state.reads, [request.read]: 'idle' } });
          if (failure !== null) {
            emitSideEffect({ kind: 'readFailed', failure });
          }
        },
      },
      following: {
        followed(state, { next }, transition) {
          if (next === null) {
            transition.emitState({ kind: 'unfollowed', reads: state.reads });
            return;
          }
          const { follow: previous } = state;
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
            shown: getFollowShown(state.shown, { sameProduct, sameRoom }),
            missedMessages: state.missedMessages && !readsContacts,
            reads: askRead(withContacts, getReadRequest(next, 'messages'), transition),
          });
        },
        // Messages reorder the list, which is re-read for them only while it shows, and once on return if any arrived.
        changed(state, { change }, transition) {
          const { follow } = state;
          if (change.productId !== follow.productId) {
            return;
          }
          // A bot is stored but never shown, so its registration changes nothing on screen.
          if (change.kind === 'bots') {
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
        /**
         * Shows what the read found while the panel still shows what it read, and starts the read due after it for what
         * the panel follows now. A failure is reported even for a read the panel left.
         */
        readEnded(state, { request, shown, failure }, { emitState, emitSideEffect, update }) {
          const current = getReadRequest(state.follow, request.read);
          const due = state.reads[request.read] === 'rereading' ? current : null;
          emitState({
            ...state,
            reads: { ...state.reads, [request.read]: due === null ? 'idle' : 'reading' },
            shown: isShallowEqual<ReadRequest | null>(current, request) ? { ...state.shown, ...shown } : state.shown,
          });
          if (due !== null) {
            update(runRead(due));
          }
          if (failure !== null) {
            emitSideEffect({ kind: 'readFailed', failure });
          }
        },
      },
    },
    onEffect: effect => {
      reportFailedChatStorage(effect.failure.error, effect.failure.step);
    },
    onError: error => {
      report.defect(error, {
        step: 'store_transition',
        metric: storeTransitionMetric,
        message: '[dot.li chat] A chat store transition threw',
      });
    },
  });
  const view = computed(machine.state, (current): ChatView => {
    switch (current.kind) {
      case 'unfollowed':
        return NO_VIEW;
      case 'following':
        return { productId: current.follow.productId, roomId: current.follow.roomId, ...current.shown };
    }
  });
  view.eq = isShallowEqual;

  return {
    /** The followed product's rooms and the open room's messages, kept current with every write. */
    view,
    /**
     * Points the view at `next`, or at nothing for null, after which a read still running reaches no view and none due
     * after it runs. Idempotent. Never throws: a read that fails shows in the view's failed flags.
     */
    follow: (next: ChatFollow | null): void => {
      machine.update({ kind: 'followed', next });
    },
    /** Resolves once no view read is queued or running. Never rejects, as a failed read is reported and shown. */
    settle: (): Promise<void> => machine.await(),
    /** Hears a write the store made, which reads again what it changed on screen. Never throws. */
    noteChange: (change: ChatChange): void => {
      machine.update({ kind: 'changed', change });
    },
  };

  /** The reads with `request` asked for: started when none of its kind runs, and due after the one that does. */
  function askRead(reads: Reads, request: ReadRequest | null, { update }: Transition<ViewMachine>): Reads {
    if (request === null) {
      return reads;
    }
    switch (reads[request.read]) {
      case 'idle':
        update(runRead(request));
        return { ...reads, [request.read]: 'reading' };
      case 'reading':
      case 'rereading':
        return { ...reads, [request.read]: 'rereading' };
    }
  }

  /** Reads what `request` names, ending in the event that carries what it shows. */
  function runRead(request: ReadRequest): Promise<ViewEvent> {
    return read(request).then(
      (shown): ViewEvent => ({ kind: 'readEnded', request, shown, failure: null }),
      (error: unknown): ViewEvent => {
        const { shown, step } = READ_FAILURES[request.read];
        return { kind: 'readEnded', request, shown, failure: { step, error } };
      },
    );
  }

  /** What a read of `request` shows. Rejects when the store fails. */
  async function read(request: ReadRequest): Promise<ReadShown> {
    switch (request.read) {
      case 'contacts': {
        const { productId } = request;
        const [rooms, lastMessageTimes] = await Promise.all([
          repo.listRooms(productId),
          repo.readLatestMessageTimestamps(productId),
        ]);
        return { contacts: { rooms, lastMessageTimes }, contactsFailed: false };
      }
      case 'messages':
        return { messages: await repo.listMessages(request.productId, request.roomId), messagesFailed: false };
    }
  }
}

/** The read of kind `read` that `follow` shows, or null when it shows none. */
function getReadRequest(follow: ChatFollow, read: keyof Reads): ReadRequest | null {
  switch (read) {
    case 'contacts':
      return { read, productId: follow.productId };
    case 'messages':
      return follow.roomId === null ? null : { read, productId: follow.productId, roomId: follow.roomId };
  }
}

/** What the next follow shows: what `shown` holds of the same product and room, until their reads land. */
function getFollowShown(shown: ChatShown, { sameProduct, sameRoom }: GetFollowShownParams): ChatShown {
  return {
    contacts: sameProduct ? shown.contacts : null,
    contactsFailed: sameProduct && shown.contactsFailed,
    messages: sameRoom ? shown.messages : null,
    messagesFailed: sameRoom && shown.messagesFailed,
  };
}
