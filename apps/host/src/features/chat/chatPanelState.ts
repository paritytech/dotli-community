// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Outside Solid, since islands that hydrate apart read it. It keeps no rooms or messages.

import { createSharedRun, registerStoreStateReset, registerAtomReset, isShallowEqual } from '@dotli/shared';
import type { ProductId } from '@parity/truapi';
import { atom, type ReadableAtom } from 'nanostores';
import { createReporter } from '@dotli/metrics';
import type { ChatStore } from './createChatStore.js';
import type { ChatChange, ChatView } from './createChatView.js';
import type { OpenRoomParams } from './chat.js';
import { chatConnections, type ChatConnections } from './createChatConnections.js';
import { productState } from '../page/index.js';
import { authState } from '../account/index.js';
import { reportLazyMiss } from '../../kit/reportLazyMiss.js';

export type ChatPanelState = {
  label: string | null;
  /** The id the core parsed for the loaded product, which keys its chat. */
  runtimeProductId: ProductId | null;
  /**
   * Whether a chat connection registered for the product on show since it showed. It stays true when that
   * registration ends, so a post in the gap fails as not connected rather than the panel closing.
   */
  available: boolean;
  /** Whether the product has a room. False until a read or a write shows one. */
  hasContacts: boolean;
  loggedIn: boolean;
  open: boolean;
  /** null shows the room list, or the room when it is the only one. */
  activeRoomId: string | null;
  unreadByRoom: Readonly<Record<string, number>>;
  composerError: string | null;
  /** One-shot: focus the composer once the room the user picked shows. */
  focusComposer: boolean;
};

type ChatSource = Pick<ChatStore, 'subscribe' | 'hasContacts'>;

type ChatRegistry = Pick<ChatConnections, 'get' | 'onRegister'>;

type Params = {
  /** Loads the chat store whose product messages count as unread and whose rooms show the button. */
  chat?: () => Promise<ChatSource>;
  /** The connections whose registration for the product on show makes chat available. */
  connections?: ChatRegistry;
};

const report = createReporter({ flow: 'chat' });

const panel = atom<ChatPanelState>({
  label: null,
  runtimeProductId: null,
  available: false,
  hasContacts: false,
  loggedIn: false,
  open: false,
  activeRoomId: null,
  unreadByRoom: {},
  composerError: null,
  focusComposer: false,
});
// Repeated product or session events rebuild an equal state.
panel.eq = isShallowEqual;
registerAtomReset(panel);
const store: ReadableAtom<ChatPanelState> = panel;

// The panel hydrates as an island of its own, so its element is handed over here, not passed in.
let panelElement: HTMLElement | undefined;

// A second subscription would count each product message twice as unread.
const run = createSharedRun<Required<Params>>({ begin: beginFollowing });

/** What the chat panel and its button show. */
export const chatPanelState = {
  /** What the panel and its button show. Notifies only when a field changes. */
  store,
  /** Returns whether `state` shows the chat button. Never throws. */
  isButtonVisible,
  /** Returns the unread count summed over every room of `state`. Never throws. */
  getTotalUnread,
  /** Opens or closes the panel. The panel stays closed while the button is hidden. Never throws. */
  setOpen,
  /**
   * Shows the room `roomId` and focuses its composer, unless `focusComposer` is false, as for a room the panel opens
   * itself. Never throws.
   */
  openRoom,
  /** Shows the room list and clears the composer error, also in place of a room that no longer exists. Never throws. */
  backToRooms,
  /** Clears the unread count of the room `roomId`. Never throws. */
  markRoomSeen,
  /**
   * Marks the room `view` follows seen each time a read of its messages lands, until the returned stop. Only a read
   * that `view` shows marks a room, so one for a room it no longer follows marks nothing. Never throws.
   */
  markFollowedRoomSeen,
  /** Shows `message` as the composer's error, or clears it with null. Never throws. */
  setComposerError,
  /** Returns whether a room asked to focus its composer, and clears that one-shot request. Never throws. */
  claimComposerFocus,
  /**
   * Follows the session, the product on show, the chat connections registered for it and its chat until the returned
   * stop. The chat is followed from once its store has loaded, which reads whether the product has a room, and again
   * for each product loaded and each connection registered after. A call while the follows run joins them and ignores
   * its params, and they end with the last caller's stop.
   */
  start,
  /** Returns the panel's element, or undefined when none is handed over. Never throws. */
  getElement,
  /**
   * Hands over the panel's element. Returns a release that clears it, unless another element was handed over since.
   * Never throws.
   */
  setElement,
};

// The store resets itself. The follows end and the element is let go.
registerStoreStateReset(() => {
  run.end();
  panelElement = undefined;
});

/**
 * Every chat call needs a session, so a logged-out user gets no chat rather than denied calls. A product with no room
 * has nothing to show.
 */
function isButtonVisible(state: ChatPanelState = panel.get()): boolean {
  return state.available && state.loggedIn && state.hasContacts;
}

function getTotalUnread(state: ChatPanelState = panel.get()): number {
  let total = 0;
  for (const count of Object.values(state.unreadByRoom)) {
    total += count;
  }
  return total;
}

function setOpen(open: boolean): void {
  update({ open });
}

function openRoom(roomId: string, { focusComposer = true }: OpenRoomParams = {}): void {
  update({ activeRoomId: roomId, focusComposer });
}

function backToRooms(): void {
  update({ activeRoomId: null, composerError: null });
}

function markRoomSeen(roomId: string): void {
  const { unreadByRoom } = panel.get();
  if (!(roomId in unreadByRoom)) {
    return;
  }
  const rest = { ...unreadByRoom };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- shallow immutable copy of the unread record, removing one entry.
  delete rest[roomId];
  update({ unreadByRoom: rest });
}

function markFollowedRoomSeen(view: ReadableAtom<ChatView>): () => void {
  let shown: ChatView['messages'] = null;
  function markLandedRead(): void {
    const { messages, roomId } = view.get();
    if (messages === shown) {
      return;
    }
    shown = messages;
    if (messages !== null && roomId !== null) {
      markRoomSeen(roomId);
    }
  }
  return view.subscribe(markLandedRead);
}

function setComposerError(message: string | null): void {
  update({ composerError: message });
}

function claimComposerFocus(): boolean {
  if (!panel.get().focusComposer) {
    return false;
  }
  update({ focusComposer: false });
  return true;
}

function start({
  chat = async () => (await import('./createChatStore.js')).chatStore,
  connections = chatConnections,
}: Params = {}): () => void {
  return run.join({ chat, connections });
}

function getElement(): HTMLElement | undefined {
  return panelElement;
}

function setElement(element: HTMLElement): () => void {
  panelElement = element;
  function releaseElement(): void {
    if (panelElement === element) {
      panelElement = undefined;
    }
  }
  return releaseElement;
}

function beginFollowing({ chat, connections }: Required<Params>): () => void {
  followSession();
  followProduct(connections);
  // The store's chunk stays off the boot path, so following the chat starts once it loads.
  const following = new AbortController();
  chat().then(
    store => {
      if (following.signal.aborted) {
        return;
      }
      following.signal.addEventListener('abort', store.subscribe(followChat));
      // Listens from once the store loads, so a product load or a registration is committed to the panel before its
      // rooms are checked.
      following.signal.addEventListener(
        'abort',
        productState.store.listen(() => {
          checkContacts(store);
        }),
      );
      following.signal.addEventListener(
        'abort',
        connections.onRegister(() => {
          checkContacts(store);
        }),
      );
      checkContacts(store);
    },
    (error: unknown) => {
      reportLazyMiss({ report, step: 'chat_store_load', error });
    },
  );
  const unsubscribes = [
    authState.loggedInStore.listen(followSession),
    productState.store.listen(() => {
      followProduct(connections);
    }),
    connections.onRegister(followRegistration),
    () => {
      following.abort();
    },
  ];
  function unsubscribe(): void {
    for (const unsubscribeOne of unsubscribes) {
      unsubscribeOne();
    }
  }
  return unsubscribe;
}

function followSession(): void {
  update({ loggedIn: authState.loggedInStore.get() });
}

function followProduct(connections: ChatRegistry): void {
  const product = productState.store.get();
  if (product.status === 'error') {
    update({ label: null, runtimeProductId: null, available: false, hasContacts: false });
    return;
  }
  if (product.status !== 'loaded') {
    return;
  }
  const { label, productId } = product;
  const state = panel.get();
  const base =
    state.label === label
      ? state
      : {
          ...state,
          label,
          available: false,
          hasContacts: false,
          activeRoomId: null,
          unreadByRoom: {},
          composerError: null,
        };
  // A connection may register before the product shows, as well as after.
  commit({
    ...base,
    runtimeProductId: productId,
    available: base.available || connections.get(productId) !== undefined,
  });
}

/** A registration ending is not heard: chat stays available until another product shows. */
function followRegistration(productId: string): void {
  if (productId === panel.get().runtimeProductId) {
    update({ available: true });
  }
}

/**
 * Reads whether the product on show has a room, unless it is known to have one. Each load reads again while
 * none is known, as another tab of the product may have added one meanwhile.
 */
function checkContacts(store: ChatSource): void {
  const { runtimeProductId: productId, available, hasContacts } = panel.get();
  if (productId === null || !available || hasContacts) {
    return;
  }
  void store.hasContacts(productId).then(has => {
    // A read for a product no longer on show tells nothing about the one that is.
    if (has && panel.get().runtimeProductId === productId) {
      update({ hasContacts: true });
    }
  });
}

function followChat(change: ChatChange): void {
  switch (change.kind) {
    case 'rooms':
      // The store announces a room write once it is stored, so the product has one.
      if (change.productId === panel.get().runtimeProductId) {
        update({ hasContacts: true });
      }
      return;
    case 'bots':
      return;
    case 'message':
      countUnreadMessage(change);
      return;
  }
}

function countUnreadMessage(change: Extract<ChatChange, { kind: 'message' }>): void {
  const state = panel.get();
  if (change.author !== 'product' || change.productId !== state.runtimeProductId) {
    return;
  }
  // A conversation outside the rooms has no row the user could open to clear its count.
  if (!change.inRoom) {
    return;
  }
  if (state.open && state.activeRoomId === change.roomId) {
    return;
  }
  update({
    unreadByRoom: {
      ...state.unreadByRoom,
      [change.roomId]: (state.unreadByRoom[change.roomId] ?? 0) + 1,
    },
  });
}

function commit(next: ChatPanelState): void {
  panel.set(next.open && !isButtonVisible(next) ? { ...next, open: false } : next);
}

function update(patch: Partial<ChatPanelState>): void {
  commit({ ...panel.get(), ...patch });
}
