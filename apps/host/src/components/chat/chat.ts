// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the chat panel reads and asks for. The room and bot records hold only the fields the panel shows, so a story
// builds them without a product, and the runtime's records fit them.

import type { Accessor } from 'solid-js';
import type {
  HexString,
  HostRendererActionSubscribeItem,
  ProductRendererRenderRequest,
  RendererNode,
} from '@parity/truapi';
import type { ChatMessageRecord, ChatRoomFooter } from '../../runtime/chat/store.js';

/** Where a custom message's renderer streams its trees. */
export interface ChatRenderSink {
  onUpdate: (node: RendererNode) => void;
  onError?: (error: Error) => void;
}

/** What a message asks of the product: a custom tree, a tap on an action or a gesture inside a tree. */
export interface ChatMessageActions {
  /** Streams replacement trees into `sink` until disposed. */
  renderCustomMessage: (productId: string, request: ProductRendererRenderRequest, sink: ChatRenderSink) => () => void;
  triggerAction: (
    productId: string,
    roomId: string,
    trigger: { messageId: string; actionId: string; payload?: HexString },
  ) => Promise<void>;
  triggerRendererAction: (productId: string, item: HostRendererActionSubscribeItem) => Promise<void>;
}

export interface ChatRoom {
  roomId: string;
  name: string;
  /** URL or base64 image, as supplied by the product. */
  icon: string;
  createdAt: number;
  /** Unset shows the text input. */
  footer?: ChatRoomFooter | undefined;
}

export interface ChatBot {
  botId: string;
  name: string;
  /** URL or base64 image, as supplied by the product. */
  icon: string;
  createdAt: number;
}

export interface ChatContacts {
  rooms: readonly ChatRoom[];
  bots: readonly ChatBot[];
  lastMessageTimes: ReadonlyMap<string, number>;
}

/** The product's rooms and the shown room's messages, as the open panel reads them. */
export interface ChatFeed {
  /** Null until the first room list read lands. */
  contacts: Accessor<ChatContacts | null>;
  /** The last room list read failed. The rooms read before it stay. */
  contactsFailed: Accessor<boolean>;
  /** Null until the shown room's first read lands. */
  messages: Accessor<readonly ChatMessageRecord[] | null>;
  messagesFailed: Accessor<boolean>;
  /** Calls `listener` as the feed changes, before the panel renders the change. Returns the stop. */
  onChange: (listener: () => void) => () => void;
  /** Reads the room `shown` names, or only the room list while it is null, until the panel closes. */
  follow: (shown: Accessor<string | null>) => void;
}

/** What the open panel shows of the page's chat state, and what it asks the page to do. */
export interface ChatConversation {
  loggedIn: Accessor<boolean>;
  /** The product's published name, else its label. The title while no room is open. */
  productName: Accessor<string | null>;
  /** Null shows the room list. */
  activeRoomId: Accessor<string | null>;
  unreadByRoom: Accessor<Readonly<Record<string, number>>>;
  composerError: Accessor<string | null>;
  /** Called as the panel body opens, under its owner, so its reads stop as the panel closes. */
  openFeed: () => ChatFeed;
  openRoom: (roomId: string) => void;
  backToRooms: () => void;
  /** The open room is no longer in the list. */
  roomGone: () => void;
  /** True once after a room was picked, which asks the composer to take focus. */
  claimComposerFocus: () => boolean;
  setComposerError: (message: string | null) => void;
  /** Posts the user's reply to the open room. Rejects when it cannot reach the product, the message kept. */
  send: (roomId: string, text: string) => Promise<void>;
  actions: ChatMessageActions;
}
