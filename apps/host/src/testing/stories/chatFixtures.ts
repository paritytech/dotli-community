// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A product's chat and the page's chat state, as a story gives them to the chat views, with what the views asked of
// them. Plays move it the way the page's chat store and chat state do. It keeps no rules of its own: a story that
// needs unread counts or a closed panel writes them, as the page's chat state would.

import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';
import type {
  ChatMessageContent,
  HostRendererActionSubscribeItem,
  ProductRendererRenderRequest,
  RendererNode,
} from '@parity/truapi';
import { isShallowEqual } from '@dotli/shared';
import { atom, type WritableAtom } from 'nanostores';
import { useStore } from '@dotli/stores-solid';
import { chatUnreadLabel } from '../../features/chat/unread.js';
import type { ChatMessageRecord } from '../../features/chat/createChatStore.js';
import { ChatReplyUndeliveredError } from '../../features/chat/chatReplyUndeliveredError.js';
import type { ChatRenderSink } from '../../features/chat/chat.js';
import type { ChatBot, ChatContacts, ChatConversation, ChatFeed, ChatRoom } from '../../features/chat/chat.js';
import type { ChatButtonProps } from '../../features/chat/ChatButton.js';
import { DELIVERY_TIME_PICKER, PAYMENT_REQUEST } from './customMessageTrees.js';

const PRODUCT = 'market.dot';
const MINUTE = 60_000;

/** The page's chat state, as the views read it. */
export type StageState = {
  open: boolean;
  /** Whether the chat button shows. */
  available: boolean;
  loggedIn: boolean;
  productName: string | null;
  productDomain: string | null;
  activeRoomId: string | null;
  unreadByRoom: Readonly<Record<string, number>>;
  /** The page's total across rooms, which the button shows while the panel is closed. */
  unread: number;
  composerError: string | null;
  focusComposer: boolean;
};

const INITIAL: StageState = {
  open: false,
  available: true,
  loggedIn: true,
  productName: 'Market',
  productDomain: 'market.dot',
  activeRoomId: null,
  unreadByRoom: {},
  unread: 0,
  composerError: null,
  focusComposer: false,
};

type FeedState = {
  contacts: ChatContacts | null;
  contactsFailed: boolean;
  messages: readonly ChatMessageRecord[] | null;
  messagesFailed: boolean;
};

/** The page's chat state as the host's dock reads it. */
export type StageDock = {
  open: Accessor<boolean>;
  available: Accessor<boolean>;
  onOpenChange: (open: boolean) => void;
  conversation: ChatConversation;
  handOver: (panel: HTMLElement) => () => void;
};

/** The panel's chat, and whether a frame standing in for the drawer holds the panel. */
export type StagePanel = Pick<StageDock, 'open' | 'conversation'>;

/** A user reply as it reached the product. */
export type Published = {
  roomId: string;
  text: string;
};

export type ChatStage = {
  state: WritableAtom<StageState>;
  update(patch: Partial<StageState>): void;
  rooms: ChatRoom[];
  bots: ChatBot[];
  messages: ChatMessageRecord[];
  /** While set, the room list cannot be read. */
  contactsFail: boolean;
  /** While set, no read lands, so the room list stays loading. */
  readsHeld: boolean;
  /** While set, the shown conversation cannot be read. */
  messagesFail: boolean;
  /** While set, a reply is kept but cannot reach the product, with this error. */
  sendError: Error | null;
  /** While set, a reply is not kept, and the send rejects with this error. */
  refuseError: Error | null;
  /** The tree the product renders for a custom message of each type. A type with none stays loading. */
  customTrees: Readonly<Record<string, RendererNode>>;
  published: Published[];
  actions: { roomId: string; messageId: string; actionId: string }[];
  rendererActions: HostRendererActionSubscribeItem[];
  renders: { request: ProductRendererRenderRequest; sink: ChatRenderSink }[];
  /** How many renders were disposed. */
  disposedRenders: () => number;
  createRoom(roomId: string, name: string, icon?: string): void;
  registerBot(botId: string, name: string, icon?: string): void;
  productSays(roomId: string, content: ChatMessageContent | string): void;
  /** Adds a message in `roomId`, `minutesAgo` before now, from the product unless another author is given. */
  say(roomId: string, content: unknown, options: { minutesAgo: number; author?: ChatMessageRecord['author'] }): void;
  /** Seeds rooms r0 to r(count - 1), the newest last, and `messages` in r0, a second apart up to now. */
  seed(count: number, messages?: readonly ChatMessageContent[]): void;
  conversation: ChatConversation;
  /** The panel's chat, and whether its frame holds it. */
  panel: StagePanel;
  /** The dock's props, as the host's chat state gives them. */
  dock: StageDock;
  button: ChatButtonProps;
  /** The panel element the dock handed over. */
  panelElement: () => HTMLElement | undefined;
  /** Stops the views following the stage's state, for the story's cleanup. */
  dispose: () => void;
};

/** A fresh chat for one story. */
export function chatStage(initial: Partial<StageState> = {}): ChatStage {
  const state = atom<StageState>({ ...INITIAL, ...initial });
  state.eq = isShallowEqual;
  const feed = atom<FeedState>({ contacts: null, contactsFailed: false, messages: null, messagesFailed: false });
  feed.eq = isShallowEqual;
  // What the views read, following each write as the page's stores reach them through `useStore`.
  const [current, setCurrent] = createSignal(state.get());
  const unlisten = state.listen(() => setCurrent(state.get()));
  // Strictly rising and close to now, so the list's recency order never ties and bubbles read "just now".
  let clock = 0;
  const stamp = (): number => (clock = Math.max(Date.now(), clock + 1));
  let shownRoom: string | null = null;
  let following = false;
  let disposed = 0;
  let panelElement: HTMLElement | undefined;

  const update = (patch: Partial<StageState>): void => {
    state.set({ ...state.get(), ...patch });
  };

  const read = (): void => {
    if (!following || stage.readsHeld) {
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
    onChange: listener => feed.listen(listener),
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
    productDomain: () => current().productDomain,
    activeRoomId: () => current().activeRoomId,
    unreadByRoom: () => current().unreadByRoom,
    composerError: () => current().composerError,
    openFeed,
    openRoom: (roomId, { focusComposer = true } = {}) => {
      update({ activeRoomId: roomId, focusComposer });
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
      if (stage.refuseError !== null) {
        return Promise.reject(stage.refuseError);
      }
      append(roomId, 'user', { tag: 'Text', value: { text } });
      stage.published.push({ roomId, text });
      return stage.sendError === null
        ? Promise.resolve()
        : Promise.reject(new ChatReplyUndeliveredError(roomId, stage.sendError));
    },
    actions: {
      renderCustomMessage: ({ request, sink }) => {
        stage.renders.push({ request, sink });
        // Only a chat message's render reaches the chat.
        const tree =
          request.context.tag === 'ChatMessage' ? stage.customTrees[request.context.value.messageType] : undefined;
        if (tree !== undefined) {
          sink.onUpdate(tree);
        }
        return () => {
          disposed += 1;
        };
      },
      triggerAction: ({ roomId, trigger }) => {
        stage.actions.push({ roomId, messageId: trigger.messageId, actionId: trigger.actionId });
        return Promise.resolve();
      },
      triggerRendererAction: (_productId, item) => {
        stage.rendererActions.push(item);
        return Promise.resolve();
      },
      loadImage: () => Promise.reject(new Error('No image in this story')),
    },
  };

  const stage: ChatStage = {
    state,
    update,
    rooms: [],
    bots: [],
    messages: [],
    contactsFail: false,
    readsHeld: false,
    messagesFail: false,
    sendError: null,
    refuseError: null,
    customTrees: {},
    published: [],
    actions: [],
    rendererActions: [],
    renders: [],
    disposedRenders: () => disposed,
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
    say: (roomId, content, { minutesAgo, author = 'product' }) => {
      const seq = stage.messages.length + 1;
      stage.messages.push({
        seq,
        productId: PRODUCT,
        roomId,
        messageId: `m${String(seq)}`,
        author,
        content,
        timestamp: Date.now() - minutesAgo * MINUTE,
      });
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
      conversation,
    },
    dock: {
      open: () => current().open,
      available: () => current().available,
      onOpenChange: open => {
        update({ open });
      },
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
    dispose: unlisten,
  };
  return stage;
}

/**
 * Fills `roomId` with a shop's conversation that holds every kind of message: runs from the product and the user, rich
 * text, a file, both action layouts, events and two custom messages the product renders.
 */
export function seedEveryKind(stage: ChatStage, roomId: string): void {
  stage.customTrees = { ...stage.customTrees, 'delivery-time': DELIVERY_TIME_PICKER, payment: PAYMENT_REQUEST };
  const say = (content: unknown, minutesAgo: number, author: ChatMessageRecord['author'] = 'product'): void => {
    stage.say(roomId, content, { minutesAgo, author });
  };
  say({ tag: 'Text', value: { text: 'Your order #4821 is confirmed.' } }, 30);
  say({ tag: 'Text', value: { text: 'The kitchen starts at 4:45 PM.' } }, 30);
  say({ tag: 'Text', value: { text: 'When should we bring it?' } }, 30);
  say({ tag: 'Custom', value: { messageType: 'delivery-time', payload: '0x01' } }, 28);
  say({ tag: 'Text', value: { text: 'Standard is great' } }, 26, 'user');
  say({ tag: 'Text', value: { text: 'Please ring twice, the bell is quiet.' } }, 26, 'user');
  say({ tag: 'Reaction', value: { emoji: '👍' } }, 25);
  say({ tag: 'RichText', value: { text: 'Here is the receipt and the route.', media: [{}, {}] } }, 20);
  say({ tag: 'File', value: { fileName: 'receipt-4821.pdf' } }, 20);
  say(
    {
      tag: 'Actions',
      value: {
        text: 'How was your last order?',
        layout: 'Column',
        actions: ['Great', 'Something was missing'].map(title => ({ actionId: title, title })),
      },
    },
    12,
  );
  say({ tag: 'ReactionRemoved', value: { emoji: '👍' } }, 10);
  say({ tag: 'Hologram', value: {} }, 8);
  say({ tag: 'Custom', value: { messageType: 'payment', payload: '0x02' } }, 4);
  say(
    {
      tag: 'Actions',
      value: {
        text: 'Anything else for this order?',
        layout: 'Grid',
        actions: ['Add a drink', 'No, thanks'].map(title => ({ actionId: title, title })),
      },
    },
    2,
  );
}

/** Rooms of a shop: two with unread messages, a bot, and one the user can only read. Orders holds every kind. */
export function seedShop(stage: ChatStage): void {
  stage.rooms = [
    { roomId: 'orders', name: 'Market orders', icon: '', createdAt: 0 },
    { roomId: 'courier', name: 'Courier', icon: '', createdAt: 0 },
    { roomId: 'promos', name: 'Promotions', icon: '', createdAt: 0, footer: 'Empty' },
  ];
  stage.bots = [{ botId: 'support', name: 'Support', icon: '', createdAt: 0 }];
  stage.say('promos', { tag: 'Text', value: { text: 'Free delivery all weekend.' } }, { minutesAgo: 3 * 24 * 60 });
  stage.say('courier', { tag: 'Text', value: { text: 'I am two streets away.' } }, { minutesAgo: 24 * 60 + 5 });
  stage.say('courier', { tag: 'Text', value: { text: 'Is the gate open?' } }, { minutesAgo: 24 * 60 + 4 });
  stage.say('courier', { tag: 'Text', value: { text: 'Code is 4521' } }, { minutesAgo: 24 * 60, author: 'user' });
  stage.say('support', { tag: 'Text', value: { text: 'How can we help?' } }, { minutesAgo: 60 });
  seedEveryKind(stage, 'orders');
  stage.update({ unreadByRoom: { orders: 2, support: 1 } });
}
