// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The docked chat panel's contents (components/chat/ChatPanel.tsx) over a
// stand-in chat service, so the tests count storage reads and derivations.
// tests/chat-panel.test.ts covers the panel end to end over IndexedDB.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush } from 'solid-js';
import type { RendererNode } from '@parity/truapi';
import type { ChatMessageRecord, ChatRoomRecord } from '../../../src/chat/service.js';

interface Sink {
  onUpdate: (node: RendererNode) => void;
  onError: (error: unknown) => void;
}

const h = vi.hoisted(() => ({
  rooms: [] as ChatRoomRecord[],
  times: new Map<string, number>(),
  messages: [] as ChatMessageRecord[],
  reads: { contacts: 0, messages: 0 },
  roomsFail: false,
  messagesFail: false,
  sinks: [] as Sink[],
  /** While true, each rooms and messages read waits for its release. */
  holdReads: false,
  held: [] as (() => void)[],
  unreadLabels: 0,
  captured: [] as string[],
}));

vi.mock('../../../src/chat/service.js', async original => {
  const actual = await original<typeof ServiceModule>();
  return {
    ...actual,
    chatRooms: vi.fn(async () => {
      h.reads.contacts += 1;
      if (h.roomsFail) {
        throw new Error('IndexedDB is gone');
      }
      const rooms = h.rooms.map(room => ({ ...room }));
      if (h.holdReads) {
        await new Promise<void>(resolve => h.held.push(resolve));
      }
      return rooms;
    }),
    chatBots: vi.fn(() => Promise.resolve([])),
    chatLatestMessageTimes: vi.fn(() => Promise.resolve(new Map(h.times))),
    chatMessages: vi.fn(async () => {
      h.reads.messages += 1;
      if (h.messagesFail) {
        throw new Error('IndexedDB is gone');
      }
      const messages = h.messages.map(message => ({ ...message }));
      if (h.holdReads) {
        await new Promise<void>(resolve => h.held.push(resolve));
      }
      return messages;
    }),
    userPostMessage: vi.fn(() => Promise.resolve()),
    renderCustomMessage: (_productId: string, _request: unknown, sink: Sink) => {
      h.sinks.push(sink);
      return () => undefined;
    },
  };
});

vi.mock('../../../src/state/chat-panel.js', async original => {
  const actual = await original<typeof ChatPanelModule>();
  return {
    ...actual,
    chatUnreadLabel: (count: number) => {
      h.unreadLabels += 1;
      return actual.chatUnreadLabel(count);
    },
  };
});

vi.mock('../../../../metrics/src/sentry.js', () => ({
  captureException: (_error: unknown, ctx: { step: string }) => {
    h.captured.push(ctx.step);
  },
  recordExpected: () => undefined,
}));

import { ChatPanel } from '../../../src/components/chat/ChatPanel.js';
import {
  backToChatRooms,
  chatPanelStore,
  initChatPanelState,
  openChatRoom,
  setChatPanelElement,
  setChatPanelOpen,
  setChatPanelWidth,
} from '../../../src/state/chat-panel.js';
import { setLoggedIn } from '../../../src/state/auth.js';
import { renderComponent, resetStores, settle } from '../../helpers/solid.js';
import type * as ServiceModule from '../../../src/chat/service.js';
import type * as ChatPanelModule from '../../../src/state/chat-panel.js';
import { byId, byTestId } from '../../support.js';
import { nth } from '../../helpers/nth.js';

const PRODUCT = 'chatty.dot';

/** Let reads resolve and their renders flush. */
async function idle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await settle();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

function emit(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function message(roomId: string, author: 'product' | 'user' = 'product'): void {
  emit('dotli:chat-message', { productId: PRODUCT, roomId, author });
}

function room(i: number): ChatRoomRecord {
  return {
    productId: PRODUCT,
    roomId: `r${String(i)}`,
    name: `Room ${String(i)}`,
    icon: '',
    createdAt: i,
  };
}

function text(seq: number, roomId = 'r0'): ChatMessageRecord {
  return {
    seq,
    productId: PRODUCT,
    roomId,
    messageId: `m${String(seq)}`,
    author: 'product',
    content: { tag: 'Text', value: { text: `t${String(seq)}` } },
    timestamp: 1_700_000_000_000 + seq,
  };
}

function custom(seq: number, roomId = 'r0'): ChatMessageRecord {
  return {
    ...text(seq, roomId),
    content: { tag: 'Custom', value: { messageType: 'poll', payload: '0x01' } },
  };
}

function rows(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-testid="chat-room-item"]')];
}

let removeRules: (() => void) | undefined;
let unregisterPanel: (() => void) | undefined;

async function openPanel(roomCount = 20): Promise<void> {
  // The docked panel, as ChatDock renders and registers it.
  const container = document.createElement('aside');
  container.id = 'chat-panel';
  document.body.append(container);
  unregisterPanel = setChatPanelElement(container);
  removeRules = initChatPanelState();
  emit('dotli:product-loaded', { label: 'chatty', productId: PRODUCT });
  emit('dotli:chat-availability', { label: 'chatty', chat: true });
  setLoggedIn(true);
  h.rooms = Array.from({ length: roomCount }, (_, i) => room(i));
  setChatPanelOpen(true);
  renderComponent(() => <ChatPanel />, { container });
  await idle();
}

beforeEach(() => {
  h.rooms = [];
  h.times = new Map();
  h.messages = [];
  h.reads = { contacts: 0, messages: 0 };
  h.roomsFail = false;
  h.messagesFail = false;
  h.sinks = [];
  h.holdReads = false;
  h.held = [];
  h.unreadLabels = 0;
  h.captured = [];
});

afterEach(() => {
  removeRules?.();
  unregisterPanel?.();
  removeRules = undefined;
  resetStores();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('chat panel, store slices', () => {
  it('As a user dragging the panel wider, the room rows are not worked out again', async () => {
    // Given: 20 rooms, each with an unread message.
    await openPanel();
    for (let i = 0; i < 20; i++) {
      message(`r${String(i)}`);
    }
    await idle();
    expect(rows()).toHaveLength(20);
    h.unreadLabels = 0;

    // When: 50 pointer moves of a width drag.
    for (let width = 300; width < 350; width++) {
      setChatPanelWidth(width);
      flush();
    }

    // Then
    expect(h.unreadLabels).toBe(0);
  });
});

describe('chat panel, contact reads', () => {
  it('As a user reading a conversation, messages do not re-read the hidden room list', async () => {
    // Given: a room open.
    await openPanel();
    h.messages = [text(1)];
    openChatRoom('r0');
    await idle();
    expect(byId('chat-panel-rooms').hidden).toBe(true);
    const start = { ...h.reads };

    // When: a message in another room, then one in this room.
    message('r5');
    await idle();
    h.messages.push(text(2));
    message('r0');
    await idle();

    // Then: only this room's messages were read again.
    expect(h.reads.contacts - start.contacts).toBe(0);
    expect(h.reads.messages - start.messages).toBe(1);

    // When: back to the list.
    backToChatRooms();
    await idle();

    // Then: the list is read once, for the messages it missed.
    expect(h.reads.contacts - start.contacts).toBe(1);

    // When: a message while the list shows, then opening a room.
    message('r3');
    await idle();
    openChatRoom('r3');
    await idle();

    // Then: one more read for the message, none for opening the room.
    expect(h.reads.contacts - start.contacts).toBe(2);
  });

  it('As a user, when room list reads overlap, a slow earlier read never replaces a newer one', async () => {
    // Given: a list of three rooms, and reads that wait for the test.
    await openPanel(3);
    h.holdReads = true;

    // When: the rooms change twice; the second read answers first.
    h.rooms = [room(0), room(1)];
    emit('dotli:chat-rooms-changed', { productId: PRODUCT });
    await idle();
    h.rooms = [room(0)];
    emit('dotli:chat-rooms-changed', { productId: PRODUCT });
    await idle();
    const older = nth(h.held, 0);
    const newer = nth(h.held, 1);
    expect(h.held).toHaveLength(2);
    newer();
    await idle();
    older();
    await idle();

    // Then
    expect(rows().map(row => byTestId('chat-room-name', row).textContent)).toEqual(['Room 0']);
  });

  it('As a user, going back to a list that missed nothing does not re-read it', async () => {
    // Given
    await openPanel();
    openChatRoom('r0');
    await idle();
    const start = h.reads.contacts;

    // When
    backToChatRooms();
    await idle();

    // Then
    expect(h.reads.contacts).toBe(start);
  });

  it('As a user, a room list that cannot be read says so', async () => {
    // Given
    h.roomsFail = true;

    // When
    await openPanel();

    // Then
    expect(byId('chat-panel-hint').hidden).toBe(false);
    expect(byId('chat-panel-hint').textContent).toBe('Chat could not be loaded.');
    expect(h.captured).toEqual(['chat_contacts_read']);
  });

  it('As a user, a conversation that cannot be read says so', async () => {
    // Given
    await openPanel();
    h.messagesFail = true;

    // When
    openChatRoom('r0');
    await idle();

    // Then
    expect(byId('chat-panel-hint').hidden).toBe(false);
    expect(byId('chat-panel-hint').textContent).toBe('Chat could not be loaded.');
    expect(h.captured).toEqual(['chat_messages_read']);
  });
  it('As a user back on a working list, a conversation that could not be read no longer says so', async () => {
    // Given: a conversation whose messages cannot be read.
    await openPanel();
    h.messagesFail = true;
    openChatRoom('r0');
    await idle();
    expect(byId('chat-panel-hint').textContent).toBe('Chat could not be loaded.');
    const reads = h.reads.contacts;

    // When: back to the list, which reads nothing new.
    backToChatRooms();
    await idle();

    // Then
    expect(h.reads.contacts).toBe(reads);
    expect(rows()).toHaveLength(20);
    expect(byId('chat-panel-hint').hidden).toBe(true);
  });

  it('As a user, a conversation that could not be read stops saying so once it can be', async () => {
    // Given
    await openPanel();
    h.messagesFail = true;
    openChatRoom('r0');
    await idle();
    expect(byId('chat-panel-hint').hidden).toBe(false);

    // When: a new message, and this time the read works.
    h.messagesFail = false;
    h.messages = [text(1)];
    message('r0');
    await idle();

    // Then
    expect(document.querySelectorAll('[data-testid="chat-msg"]')).toHaveLength(1);
    expect(byId('chat-panel-hint').hidden).toBe(true);
  });

  it('As a user, a room list that could not be re-read keeps saying so until it can be, whatever the conversation reads', async () => {
    // Given: the list shows, then a re-read of it fails.
    await openPanel();
    h.roomsFail = true;
    message('r3');
    await idle();
    expect(byId('chat-panel-hint').textContent).toBe('Chat could not be loaded.');

    // When: a conversation is read fine.
    h.messages = [text(1)];
    openChatRoom('r0');
    await idle();

    // Then
    expect(document.querySelectorAll('[data-testid="chat-msg"]')).toHaveLength(1);
    expect(byId('chat-panel-hint').textContent).toBe('Chat could not be loaded.');

    // When: back on the list, a message and a re-read that works.
    h.roomsFail = false;
    backToChatRooms();
    message('r4');
    await idle();

    // Then
    expect(byId('chat-panel-hint').hidden).toBe(true);
  });
});

describe('chat panel, message reads', () => {
  it('As a user, when conversation reads overlap, a slow earlier read never replaces a newer one', async () => {
    // Given: a room open, and reads that wait for the test.
    await openPanel(3);
    h.messages = [text(1)];
    openChatRoom('r0');
    await idle();
    h.holdReads = true;

    // When: two messages arrive; the second read answers first.
    h.messages.push(text(2));
    message('r0');
    await idle();
    h.messages.push(text(3));
    message('r0');
    await idle();
    const older = nth(h.held, 0);
    const newer = nth(h.held, 1);
    expect(h.held).toHaveLength(2);
    newer();
    await idle();
    older();
    await idle();

    // Then
    expect(document.querySelectorAll('[data-testid="chat-msg"]')).toHaveLength(3);
  });

  it('As a user who went back to the list, a conversation read that lands late shows nothing and marks nothing seen', async () => {
    // Given: a room open, and its read waiting.
    await openPanel(3);
    h.holdReads = true;
    h.messages = [text(1)];
    message('r1');
    await idle();
    h.held.splice(0).forEach(release => {
      release();
    });
    await idle();
    openChatRoom('r1');
    await idle();
    expect(h.held).toHaveLength(1);

    // When: back to the list, then the read lands.
    backToChatRooms();
    await idle();
    h.held.splice(0).forEach(release => {
      release();
    });
    await idle();

    // Then
    expect(document.querySelectorAll('[data-testid="chat-msg"]')).toHaveLength(0);
    expect(byTestId('chat-room-unread', nth(rows(), 1)).textContent).toBe('1');
  });
});

describe('chat panel, scrolling', () => {
  /** A messages list of `height()` px in a 200 px viewport. */
  function sized(height: () => number): HTMLElement {
    const list = byId('chat-panel-messages');
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      get: height,
    });
    Object.defineProperty(list, 'clientHeight', {
      configurable: true,
      get: () => 200,
    });
    return list;
  }

  function scrollTo(list: HTMLElement, top: number): void {
    list.scrollTop = top;
    list.dispatchEvent(new Event('scroll'));
  }

  /** Stand-in ResizeObservers: what each observes, and whether it is gone. */
  interface FakeObserver {
    callback: () => void;
    targets: Set<Element>;
    disconnected: boolean;
  }
  function fakeResizeObservers(): {
    observing: (target: Element) => FakeObserver | undefined;
  } {
    const instances: FakeObserver[] = [];
    class FakeResizeObserver {
      private entry: FakeObserver;
      constructor(callback: () => void) {
        this.entry = { callback, targets: new Set(), disconnected: false };
        instances.push(this.entry);
      }
      observe(target: Element): void {
        this.entry.targets.add(target);
      }
      unobserve(target: Element): void {
        this.entry.targets.delete(target);
      }
      disconnect(): void {
        this.entry.disconnected = true;
        this.entry.targets.clear();
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    return {
      observing: target => instances.find(o => o.targets.has(target)),
    };
  }

  /** The wrapper around the bubbles, whose height is the conversation's. */
  function thread(): HTMLElement {
    const node = byId('chat-panel-messages').querySelector<HTMLElement>('[data-testid="chat-panel-thread"]');
    if (node === null) {
      throw new Error('missing [data-testid="chat-panel-thread"]');
    }
    return node;
  }

  it('As a user reading older messages, a new message does not pull me down', async () => {
    // Given: a conversation, scrolled up.
    await openPanel(3);
    let height = 1000;
    const list = sized(() => height);
    h.messages = [text(1), text(2)];
    openChatRoom('r0');
    await idle();
    expect(list.scrollTop).toBe(1000);
    scrollTo(list, 100);

    // When
    h.messages.push(text(3));
    height = 1100;
    message('r0');
    await idle();

    // Then
    expect(document.querySelectorAll('[data-testid="chat-msg"]')).toHaveLength(3);
    expect(list.scrollTop).toBe(100);
  });

  it('As a user at the newest message, a custom message that renders later stays in view', async () => {
    // Given: a conversation at the bottom, ending with a custom message.
    vi.stubGlobal('IntersectionObserver', undefined);
    const observers = fakeResizeObservers();
    await openPanel(3);
    let height = 1000;
    const list = sized(() => height);
    h.messages = [text(1), custom(2)];
    openChatRoom('r0');
    await idle();
    expect(list.scrollTop).toBe(1000);
    scrollTo(list, 800);

    // When: its tree arrives and makes the list taller.
    height = 1300;
    nth(h.sinks, 0).onUpdate({
      tag: 'Text',
      value: {
        modifiers: [],
        props: {},
        children: [{ tag: 'String', value: { text: 'Poll' } }],
      },
    });
    await idle();
    expect(list.textContent).toContain('Poll');
    // The thread grew, so the browser reports it.
    observers.observing(thread())?.callback();

    // Then
    expect(list.scrollTop).toBe(1300);
  });
  it('As a user at the newest message, growth that changes no markup (an image, a font, a narrower panel) or a shorter list keeps me there', async () => {
    // Given: a conversation at the bottom.
    const observers = fakeResizeObservers();
    await openPanel(3);
    let height = 1000;
    const list = sized(() => height);
    h.messages = [text(1), text(2)];
    openChatRoom('r0');
    await idle();
    expect(list.scrollTop).toBe(1000);
    const observer = observers.observing(thread());
    expect(thread().querySelectorAll(':scope > [data-testid="chat-msg"]')).toHaveLength(2);

    // When: the list gets shorter (the window shrinks), which leaves the
    // scroll position short of the bottom without a scroll event, and the
    // browser reports the list's new size.
    list.scrollTop = 900;
    observers.observing(list)?.callback();

    // Then
    expect(list.scrollTop).toBe(1000);

    // When: the thread grows with no DOM change, and the observer reports it.
    height = 1250;
    observer?.callback();

    // Then
    expect(list.scrollTop).toBe(1250);

    // When: a reader scrolled up, then more growth.
    scrollTo(list, 100);
    height = 1400;
    observer?.callback();

    // Then
    expect(list.scrollTop).toBe(100);

    // When: the panel closes.
    setChatPanelOpen(false);
    await idle();

    // Then
    expect(observer?.disconnected).toBe(true);
  });

  it('As a user within 24 px of the newest message, I count as at the bottom and new messages keep me there', async () => {
    // Given: 800 px is the bottom of a 1000 px conversation.
    const observers = fakeResizeObservers();
    await openPanel(3);
    let height = 1000;
    const list = sized(() => height);
    h.messages = [text(1)];
    openChatRoom('r0');
    await idle();

    // When: 24 px short of the bottom, then growth.
    scrollTo(list, 776);
    height = 1100;
    observers.observing(thread())?.callback();

    // Then
    expect(list.scrollTop).toBe(1100);

    // When: 25 px short of the bottom, then growth.
    scrollTo(list, 775);
    height = 1200;
    observers.observing(thread())?.callback();

    // Then
    expect(list.scrollTop).toBe(775);
  });

  it('As a user reading older messages, sending a message brings me to it', async () => {
    // Given: a conversation, scrolled up.
    await openPanel(3);
    let height = 1000;
    const list = sized(() => height);
    h.messages = [text(1), text(2)];
    openChatRoom('r0');
    await idle();
    scrollTo(list, 100);

    // When
    byId('chat-panel-input', HTMLInputElement).value = 'hi';
    h.messages.push({ ...text(3), author: 'user' });
    height = 1100;
    byId('chat-panel-composer', HTMLFormElement).requestSubmit();
    await idle();

    // Then
    expect(document.querySelectorAll('[data-testid="chat-msg"]')).toHaveLength(3);
    expect(list.scrollTop).toBe(1100);
  });

  it('As a user whose browser has no ResizeObserver, the conversation still follows new messages', async () => {
    // Given
    vi.stubGlobal('ResizeObserver', undefined);
    await openPanel(3);
    let height = 1000;
    const list = sized(() => height);
    h.messages = [text(1)];
    openChatRoom('r0');
    await idle();
    expect(list.scrollTop).toBe(1000);

    // When
    h.messages.push(text(2));
    height = 1100;
    message('r0');
    await idle();

    // Then
    expect(list.scrollTop).toBe(1100);
  });
});

describe('chat panel, resizing', () => {
  it("As a user dragging the panel's edge, it resizes within 280 to 560 px and keeps the width, even when the drag is cancelled", async () => {
    // Given: a 360 px panel.
    await openPanel(3);
    const handle = byId('chat-panel-resize');
    Object.defineProperty(byId('chat-panel'), 'offsetWidth', {
      configurable: true,
      get: () => 360,
    });
    const drag = (type: string, clientX = 0): void => {
      handle.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX }));
    };

    // When
    drag('pointerdown', 1000);
    drag('pointermove', 900);

    // Then
    expect(chatPanelStore.get().width).toBe(460);

    // When
    drag('pointermove', 0);

    // Then
    expect(chatPanelStore.get().width).toBe(560);

    // When: the pointer is cancelled, then moves on.
    drag('pointermove', 950);
    drag('pointercancel');
    drag('pointermove', 1100);

    // Then
    expect(chatPanelStore.get().width).toBe(410);
    expect(localStorage.getItem('dotli:chat-panel-width')).toBe('410');
  });
});

describe('chat panel, room order', () => {
  it('As a keyboard user on a room row, a message that moves the row keeps my focus on it', async () => {
    // Given: focus on the oldest room, last in the list.
    await openPanel(5);
    const last = nth(rows(), 4);
    expect(last.textContent).toContain('Room 0');
    last.focus();

    // When: a message makes that room the most recent.
    h.times = new Map([['r0', 1_800_000_000_000]]);
    message('r0');
    await idle();

    // Then
    expect(rows()[0]).toBe(last);
    expect(document.activeElement).toBe(last);
  });
});
