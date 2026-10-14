// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A product's chat and the page's chat state, as a story gives them to the chat views, with what the views asked of
// them. Plays move it the way the page's chat store and chat state do. It keeps no rules of its own: a story that
// needs unread counts or a closed panel writes them, as the page's chat state would.

import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';
import type { ChatMessageContent, HostRendererActionSubscribeItem, ProductRendererRenderRequest } from '@parity/truapi';
import { createSyncStore, shallowEqual, type SyncStore } from '@dotli/shared';
import { useStore } from '@dotli/ui';
import { chatUnreadLabel } from '../../components/chat/unread.js';
import type { ChatMessageRecord } from '../../runtime/chat/store.js';
import type { ChatRenderSink } from '../../components/chat/chat.js';
import type { ChatBot, ChatContacts, ChatConversation, ChatFeed, ChatRoom } from '../../components/chat/chat.js';
import type { ChatButtonProps } from '../../components/chat/ChatButton.js';

const PRODUCT = 'chatty.dot';

/** The page's chat state, as the views read it. */
export interface StageState {
  open: boolean;
  width: number;
  topbarHidden: boolean;
  /** Whether the chat button shows. */
  available: boolean;
  loggedIn: boolean;
  productName: string | null;
  activeRoomId: string | null;
  unreadByRoom: Readonly<Record<string, number>>;
  /** The page's total across rooms, which the button shows while the panel is closed. */
  unread: number;
  composerError: string | null;
  focusComposer: boolean;
}

const INITIAL: StageState = {
  open: false,
  width: 360,
  topbarHidden: false,
  available: true,
  loggedIn: true,
  productName: 'chatty',
  activeRoomId: null,
  unreadByRoom: {},
  unread: 0,
  composerError: null,
  focusComposer: false,
};

interface FeedState {
  contacts: ChatContacts | null;
  contactsFailed: boolean;
  messages: readonly ChatMessageRecord[] | null;
  messagesFailed: boolean;
}

/** The page's chat state as the host's dock reads it. */
export interface StageDock {
  open: Accessor<boolean>;
  width: Accessor<number>;
  topbarHidden: Accessor<boolean>;
  available: Accessor<boolean>;
  onClose: () => void;
  onResize: (width: number) => void;
  onResizeEnd: () => void;
  conversation: ChatConversation;
  handOver: (panel: HTMLElement) => () => void;
}

/** The part of the dock's props the dock hands its panel. */
export type StagePanel = Pick<StageDock, 'open' | 'width' | 'onClose' | 'onResize' | 'onResizeEnd' | 'conversation'>;

/** A user reply as it reached the product. */
export interface Published {
  roomId: string;
  text: string;
}

export interface ChatStage {
  state: SyncStore<StageState>;
  update(patch: Partial<StageState>): void;
  rooms: ChatRoom[];
  bots: ChatBot[];
  messages: ChatMessageRecord[];
  /** While set, the room list cannot be read. */
  contactsFail: boolean;
  /** While set, the shown conversation cannot be read. */
  messagesFail: boolean;
  /** While set, a reply is kept but cannot reach the product, with this error. */
  sendError: Error | null;
  published: Published[];
  actions: { roomId: string; messageId: string; actionId: string }[];
  rendererActions: HostRendererActionSubscribeItem[];
  renders: { request: ProductRendererRenderRequest; sink: ChatRenderSink }[];
  /** How many renders were disposed. */
  disposedRenders: () => number;
  resizes: number[];
  resizeEnds: () => number;
  createRoom(roomId: string, name: string, icon?: string): void;
  registerBot(botId: string, name: string, icon?: string): void;
  productSays(roomId: string, content: ChatMessageContent | string): void;
  /** Seeds rooms r0 to r(count - 1), the newest last, and `messages` in r0, a second apart up to now. */
  seed(count: number, messages?: readonly ChatMessageContent[]): void;
  conversation: ChatConversation;
  /** The panel's props, as the host's dock gives them. */
  panel: StagePanel;
  /** The dock's props, as the host's chat state gives them. */
  dock: StageDock;
  button: ChatButtonProps;
  /** The panel element the dock handed over. */
  panelElement: () => HTMLElement | undefined;
}

/** A fresh chat for one story. */
export function chatStage(initial: Partial<StageState> = {}): ChatStage {
  const state = createSyncStore<StageState>('story_chat_state', { ...INITIAL, ...initial }, { equals: shallowEqual });
  const feed = createSyncStore<FeedState>(
    'story_chat_feed',
    { contacts: null, contactsFailed: false, messages: null, messagesFailed: false },
    { equals: shallowEqual },
  );
  // What the views read, following each write as the page's stores reach them through `useStore`.
  const [current, setCurrent] = createSignal(state.get());
  state.subscribe(() => setCurrent(state.get()));
  // Strictly rising and close to now, so the list's recency order never ties and bubbles read "just now".
  let clock = 0;
  const stamp = (): number => (clock = Math.max(Date.now(), clock + 1));
  let shownRoom: string | null = null;
  let following = false;
  let disposed = 0;
  let resizeEnds = 0;
  let panelElement: HTMLElement | undefined;

  const update = (patch: Partial<StageState>): void => {
    state.set({ ...state.get(), ...patch });
  };

  const read = (): void => {
    if (!following) {
      return;
    }
    const last = feed.get();
    const lastMessageTimes = new Map(stage.messages.map(m => [m.roomId, m.timestamp] as const));
    const contacts = stage.contactsFail
      ? last.contacts
      : { rooms: [...stage.rooms], bots: [...stage.bots], lastMessageTimes };
    let messages: readonly ChatMessageRecord[] | null = null;
    if (shownRoom !== null) {
      messages = stage.messagesFail ? last.messages : stage.messages.filter(m => m.roomId === shownRoom);
    }
    feed.set({
      contacts,
      contactsFailed: stage.contactsFail,
      messages,
      messagesFailed: shownRoom !== null && stage.messagesFail,
    });
  };

  // Reads land a task later, as the page's IndexedDB reads do.
  const readSoon = (): void => {
    setTimeout(read, 0);
  };

  const append = (
    roomId: string,
    author: ChatMessageRecord['author'],
    content: ChatMessageContent,
  ): ChatMessageRecord => {
    const message: ChatMessageRecord = {
      seq: stage.messages.length + 1,
      productId: PRODUCT,
      roomId,
      messageId: `m${String(stage.messages.length + 1)}`,
      author,
      content,
      timestamp: stamp(),
    };
    stage.messages.push(message);
    readSoon();
    return message;
  };

  const openFeed = (): ChatFeed => ({
    contacts: useStore(feed, s => s.contacts),
    contactsFailed: useStore(feed, s => s.contactsFailed),
    messages: useStore(feed, s => s.messages),
    messagesFailed: useStore(feed, s => s.messagesFailed),
    onChange: listener => feed.subscribe(listener),
    follow: (shown: Accessor<string | null>) => {
      createEffect(shown, room => {
        // Idempotent, as the page's store is.
        if (following && room === shownRoom) {
          return;
        }
        following = true;
        shownRoom = room;
        readSoon();
      });
      onCleanup(() => {
        following = false;
        shownRoom = null;
      });
    },
  });

  const conversation: ChatConversation = {
    loggedIn: () => current().loggedIn,
    productName: () => current().productName,
    activeRoomId: () => current().activeRoomId,
    unreadByRoom: () => current().unreadByRoom,
    composerError: () => current().composerError,
    openFeed,
    openRoom: roomId => {
      update({ activeRoomId: roomId, focusComposer: true });
    },
    backToRooms: () => {
      update({ activeRoomId: null, composerError: null });
    },
    roomGone: () => {
      update({ activeRoomId: null });
    },
    claimComposerFocus: () => {
      if (!state.get().focusComposer) {
        return false;
      }
      update({ focusComposer: false });
      return true;
    },
    setComposerError: message => {
      update({ composerError: message });
    },
    send: (roomId, text) => {
      append(roomId, 'user', { tag: 'Text', value: { text } });
      stage.published.push({ roomId, text });
      return stage.sendError === null ? Promise.resolve() : Promise.reject(stage.sendError);
    },
    actions: {
      renderCustomMessage: (_productId, request, sink) => {
        stage.renders.push({ request, sink });
        return () => {
          disposed += 1;
        };
      },
      triggerAction: (_productId, roomId, trigger) => {
        stage.actions.push({ roomId, messageId: trigger.messageId, actionId: trigger.actionId });
        return Promise.resolve();
      },
      triggerRendererAction: (_productId, item) => {
        stage.rendererActions.push(item);
        return Promise.resolve();
      },
    },
  };

  const frame = {
    onClose: () => {
      update({ open: false });
    },
    onResize: (width: number) => {
      stage.resizes.push(width);
      update({ width });
    },
    onResizeEnd: () => {
      resizeEnds += 1;
    },
  };

  const stage: ChatStage = {
    state,
    update,
    rooms: [],
    bots: [],
    messages: [],
    contactsFail: false,
    messagesFail: false,
    sendError: null,
    published: [],
    actions: [],
    rendererActions: [],
    renders: [],
    disposedRenders: () => disposed,
    resizes: [],
    resizeEnds: () => resizeEnds,
    createRoom: (roomId, name, icon = '') => {
      stage.rooms.push({ roomId, name, icon, createdAt: stamp() });
      readSoon();
    },
    registerBot: (botId, name, icon = '') => {
      stage.bots.push({ botId, name, icon, createdAt: stamp() });
      readSoon();
    },
    productSays: (roomId, content) => {
      append(roomId, 'product', typeof content === 'string' ? { tag: 'Text', value: { text: content } } : content);
    },
    seed: (count, messages = []) => {
      stage.rooms = Array.from({ length: count }, (_, i) => ({
        roomId: `r${String(i)}`,
        name: `Room ${String(i)}`,
        icon: '',
        createdAt: i,
      }));
      const now = Date.now();
      stage.messages = messages.map((content, i) => ({
        seq: i + 1,
        productId: PRODUCT,
        roomId: 'r0',
        messageId: `m${String(i + 1)}`,
        author: 'product',
        content,
        timestamp: now - (messages.length - i) * 1000,
      }));
      clock = now;
    },
    conversation,
    panel: {
      open: () => current().open,
      width: () => current().width,
      ...frame,
      conversation,
    },
    dock: {
      open: () => current().open,
      width: () => current().width,
      topbarHidden: () => current().topbarHidden,
      available: () => current().available,
      ...frame,
      conversation,
      handOver: el => {
        panelElement = el;
        return () => {
          panelElement = undefined;
        };
      },
    },
    button: {
      visible: () => current().available,
      open: () => current().open,
      unread: () => (current().unread === 0 ? undefined : chatUnreadLabel(current().unread)),
      onToggle: () => {
        update({ open: !state.get().open });
      },
      panel: () => panelElement,
    },
    panelElement: () => panelElement,
  };
  return stage;
}
