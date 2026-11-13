// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { GenericError, HostChatListSubscribeItem, ProductId } from '@parity/truapi';
import { createReporter, defineCount } from '@dotli/metrics';
import { createStateMachine, getErrorMessage, type HandlerOf, type MachineTypes, type Transition } from '@dotli/shared';
import type { ChatRoomRecord, ChatStore } from '../chat/createChatStore.js';

type Params = {
  chat: Pick<ChatStore, 'subscribe' | 'listRooms'>;
  productId: ProductId;
  push: (item: HostChatListSubscribeItem) => void;
  pushError: (error: GenericError) => void;
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

type RoomsEffect =
  | { kind: 'roomsRead'; rooms: ChatRoomRecord[] }
  | { kind: 'readFailed'; error: unknown }
  | { kind: 'released'; stopListening: () => void };

type RoomsMachine = MachineTypes<RoomsState, RoomsEvent, RoomsEffect>;

const report = createReporter({ flow: 'chat' });

/**
 * One room list follow transition that threw, after which the follow keeps the state its handler emitted. Tagged
 * `outcome` (error) and `reason` (the error's name).
 */
const chatRoomsTransitionMetric = defineCount<'error'>('chat.rooms_transition');

/**
 * Pushes the product's room list now and after each change to its rooms, one read at a time, so lists land in the
 * order they were read. A burst of changes during a read costs one more read. A failed read pushes its error and ends
 * the follow. Returns the stop, after which nothing is read or pushed.
 */
export function followChatRooms({ chat, productId, push, pushError }: Params): () => void {
  const stopFollowing: HandlerOf<RoomsMachine, 'reading' | 'rereading' | 'idle', 'stopped'> = (
    { stopListening },
    _event,
    { emitState, emitSideEffect },
  ) => {
    emitState({ kind: 'stopped' });
    emitSideEffect({ kind: 'released', stopListening });
  };
  const failRead: HandlerOf<RoomsMachine, 'reading' | 'rereading', 'readFailed'> = (
    { stopListening },
    { error },
    { emitState, emitSideEffect },
  ) => {
    emitState({ kind: 'stopped' });
    emitSideEffect({ kind: 'released', stopListening });
    emitSideEffect({ kind: 'readFailed', error });
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
      },
      reading: {
        roomsChanged({ stopListening }, _event, { emitState }) {
          emitState({ kind: 'rereading', stopListening });
        },
        roomsRead({ stopListening }, { rooms }, { emitState, emitSideEffect }) {
          emitState({ kind: 'idle', stopListening });
          emitSideEffect({ kind: 'roomsRead', rooms });
        },
        readFailed: failRead,
        stopped: stopFollowing,
      },
      rereading: {
        roomsRead({ stopListening }, { rooms }, transition) {
          startRead(stopListening, transition);
          transition.emitSideEffect({ kind: 'roomsRead', rooms });
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
    onEffect: effect => {
      switch (effect.kind) {
        case 'roomsRead':
          push({ rooms: effect.rooms.map(room => ({ roomId: room.roomId, participatingAs: 'RoomHost' as const })) });
          return;
        case 'readFailed':
          pushError({ reason: getErrorMessage(effect.error) });
          return;
        case 'released':
          effect.stopListening();
          return;
      }
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
}
