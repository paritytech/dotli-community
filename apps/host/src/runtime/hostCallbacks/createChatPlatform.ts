// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The product side of chat. The core checks the product's access before it forwards a call here.

import type { ChatPlatform } from '@parity/truapi-host';
import type { HostChatListSubscribeItem } from '@parity/truapi';
import { createReporter, defineCount } from '@dotli/metrics';
import { createStateMachine, getErrorMessage, type HandlerOf, type MachineTypes, type Transition } from '@dotli/shared';
import { chatStore, type ChatRoomRecord, type ChatStore } from '../chat/createChatStore.js';
import { createResultStream } from './createResultStream.js';

type Params = {
  /** The chat the product's rooms, bots and messages live in. The page's chat store by default. */
  chat?: ChatStore;
};

/** The `push` and `pushError` a room list stream hands its follow. */
type RoomsStream = Parameters<Parameters<typeof createResultStream<HostChatListSubscribeItem>>[1]>;

type FollowRoomsParams = {
  chat: Pick<ChatStore, 'subscribe' | 'listRooms'>;
  productId: string;
  push: RoomsStream[0];
  pushError: RoomsStream[1];
};

/** `rereading` is a read in flight whose list a change made stale, so another read follows it. */
type RoomsState =
  | { kind: 'starting' }
  | { kind: 'reading'; stopListening: () => void }
  | { kind: 'rereading'; stopListening: () => void }
  | { kind: 'idle'; stopListening: () => void }
  | { kind: 'stopped' };

type RoomsEvent =
  | { kind: 'started' }
  | { kind: 'roomsChanged' }
  | { kind: 'roomsRead'; rooms: ChatRoomRecord[] }
  | { kind: 'readFailed'; error: unknown }
  | { kind: 'stopped' };

type RoomsMachine = MachineTypes<RoomsState, RoomsEvent>;

const report = createReporter({ flow: 'chat' });

/**
 * One room list follow transition that threw, after which the follow keeps the state its handler emitted. Tagged
 * `outcome` (error) and `reason` (the error's name).
 */
const chatRoomsTransitionMetric = defineCount<'error'>('chat.rooms_transition');

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
        followRooms({ chat, productId: product.productId, push, pushError }),
      );
    },
  };
}

/**
 * Pushes the product's room list now and after each change to its rooms, one read at a time, so lists land in the
 * order they were read. A burst of changes during a read costs one more read. A failed read pushes its error and ends
 * the follow. Returns the stop, after which nothing is read or pushed.
 */
function followRooms({ chat, productId, push, pushError }: FollowRoomsParams): () => void {
  const stopFollowing: HandlerOf<RoomsMachine, 'starting' | 'reading' | 'rereading' | 'idle', 'stopped'> = (
    state,
    _event,
    { emitState },
  ) => {
    emitState({ kind: 'stopped' });
    switch (state.kind) {
      case 'starting':
        return;
      case 'reading':
      case 'rereading':
      case 'idle':
        state.stopListening();
        return;
    }
  };
  const failRead: HandlerOf<RoomsMachine, 'reading' | 'rereading', 'readFailed'> = (
    { stopListening },
    { error },
    { emitState },
  ) => {
    emitState({ kind: 'stopped' });
    stopListening();
    pushError({ reason: getErrorMessage(error) });
  };
  const follow = createStateMachine<RoomsMachine>({
    initial: { kind: 'starting' },
    handlers: {
      starting: {
        started(_state, _event, transition) {
          const stopListening = chat.subscribe(change => {
            if (change.kind === 'rooms' && change.productId === productId) {
              transition.update({ kind: 'roomsChanged' });
            }
          });
          startRead(stopListening, transition);
        },
        stopped: stopFollowing,
      },
      reading: {
        roomsChanged({ stopListening }, _event, { emitState }) {
          emitState({ kind: 'rereading', stopListening });
        },
        roomsRead({ stopListening }, { rooms }, { emitState }) {
          emitState({ kind: 'idle', stopListening });
          pushRooms(rooms);
        },
        readFailed: failRead,
        stopped: stopFollowing,
      },
      rereading: {
        roomsRead({ stopListening }, { rooms }, transition) {
          startRead(stopListening, transition);
          pushRooms(rooms);
        },
        readFailed: failRead,
        stopped: stopFollowing,
      },
      idle: {
        roomsChanged({ stopListening }, _event, transition) {
          startRead(stopListening, transition);
        },
        stopped: stopFollowing,
      },
      stopped: null,
    },
    onError: error => {
      report.defect(error, {
        step: 'rooms_transition',
        metric: chatRoomsTransitionMetric,
        message: '[dot.li chat] A room list follow transition threw',
      });
    },
  });
  follow.update({ kind: 'started' });
  return () => {
    follow.update({ kind: 'stopped' });
  };

  /** Moves to `reading` and reads the room list. */
  function startRead(stopListening: () => void, { emitState, update }: Transition<RoomsMachine>): void {
    emitState({ kind: 'reading', stopListening });
    update(
      chat.listRooms(productId).then(
        rooms => ({ kind: 'roomsRead', rooms }),
        (error: unknown) => ({ kind: 'readFailed', error }),
      ),
    );
  }

  function pushRooms(rooms: ChatRoomRecord[]): void {
    push({ rooms: rooms.map(room => ({ roomId: room.roomId, participatingAs: 'RoomHost' as const })) });
  }
}
