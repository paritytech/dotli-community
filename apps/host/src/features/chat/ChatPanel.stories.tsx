// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChatMessageContent } from '@parity/truapi';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { appears, byId, byTestId } from '@dotli/ui/testing';
import { ChatOnPage } from '../../testing/stories/chatFrames.js';
import { type ChatStage, chatStage, seedEveryKind, seedShop } from '../../testing/stories/chatFixtures.js';
import { ChatPanel } from './ChatPanel.js';

// The panel in the drawer it lives in, open as the page shows it.

/** The story's chat with the drawer open, fresh for each. */
let stage: ChatStage = chatStage({ open: true });

function textOf(text: string): ChatMessageContent {
  return { tag: 'Text', value: { text } };
}

const LONG = 'A message long enough to take a few lines in the panel.';
const FORTY = Array.from({ length: 40 }, (_, i) => textOf(`${String(i + 1)}. ${LONG}`));

// The drawer renders into the body, outside the story's canvas.
const body = within(document.body);

const meta = {
  title: 'Host/Chat/ChatPanel',
  component: ChatPanel,
  args: { conversation: stage.conversation },
  parameters: { chrome: true },
  // The drawer covers the page it opens on, so it has no docs block.
  tags: ['!autodocs'],
  beforeEach: () => {
    stage = chatStage({ open: true });
    return stage.dispose;
  },
  render: () => <ChatOnPage stage={stage} />,
} satisfies Meta<typeof ChatPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`Nothing at ${String(index)}`);
  }
  return item;
}

/** The conversation, once the panel's code has loaded. */
function conversation(): Promise<HTMLElement> {
  return appears('#chat-panel-messages');
}

/** Scroll room left below the reader. */
function belowView(list: HTMLElement): number {
  return list.scrollHeight - list.scrollTop - list.clientHeight;
}

/** Scrolls the conversation as a reader would, and waits for the panel to hear it. */
async function scrollTo(list: HTMLElement, top: number): Promise<void> {
  const heard = new Promise(resolve => {
    list.addEventListener('scroll', resolve, { once: true });
  });
  list.scrollTop = top;
  await heard;
}

function rows(): HTMLElement[] {
  return body.queryAllByTestId('chat-room-item');
}

/** The room's row, once the list shows it. */
async function findRow(name: string): Promise<HTMLElement> {
  let found: HTMLElement | undefined;
  await waitFor(() => {
    found = rows().find(row => within(row).getByTestId('chat-room-name').textContent === name);
    return expect(found).toBeDefined();
  });
  if (found === undefined) {
    throw new Error(`No row for ${name}`);
  }
  return found;
}

/** Opens a room by its row and waits for its conversation to show `count` messages at the newest one. */
async function openRoom(name: string, count: number): Promise<HTMLElement> {
  (await findRow(name)).click();
  const list = await conversation();
  await waitFor(() => expect(within(list).getAllByTestId('chat-msg')).toHaveLength(count));
  await waitFor(() => expect(belowView(list)).toBeLessThanOrEqual(1));
  return list;
}

/** As a user of a product with one room, I see the drawer open on its conversation, with every kind of message. */
export const OneRoom: Story = {
  beforeEach: () => {
    stage.rooms = [{ roomId: 'market', name: 'Market', icon: '', createdAt: 0 }];
    seedEveryKind(stage, 'market');
  },
};

/** As a user of a product with several rooms, I see their list, with each room's kind, time and unread. */
export const Rooms: Story = {
  beforeEach: () => {
    seedShop(stage);
  },
};

/** As a user, I see the chat loading before its rooms are read. */
export const RoomsLoading: Story = {
  beforeEach: () => {
    stage.readsHeld = true;
  },
};

/** As a logged-out user, I am told chat opens once I log in. */
export const LoggedOut: Story = {
  beforeEach: () => {
    stage.update({ loggedIn: false });
  },
};

/** As a user of a product that has started no chat, I am told the app has not started one yet. */
export const NoRooms: Story = {};

/** As a user, I am told when the room list cannot be read. */
export const RoomsFailed: Story = {
  beforeEach: () => {
    stage.contactsFail = true;
  },
};

/** As a user, I see a room with no messages say so. */
export const NoMessages: Story = {
  beforeEach: () => {
    seedShop(stage);
    stage.rooms = [...stage.rooms, { roomId: 'returns', name: 'Returns', icon: '', createdAt: 0 }];
    stage.update({ activeRoomId: 'returns' });
  },
};

/** As a user whose message did not send, I am told so above the composer. */
export const SendFailed: Story = {
  beforeEach: () => {
    seedShop(stage);
    stage.update({ activeRoomId: 'courier', composerError: 'Message not sent. Try again.' });
  },
};

/**
 * As a user, I see a room opened from the list under a head that names it and the product, with a way back to the
 * list and what the other rooms hold unread.
 */
export const RoomOpen: Story = {
  beforeEach: () => {
    seedShop(stage);
    stage.update({ activeRoomId: 'orders' });
  },
  play: async ({ step }) => {
    await step('Given the open room has unread messages of its own and one other room has one', async () => {
      await waitFor(() => expect(byId('chat-panel-title')).toHaveTextContent('Market orders'));
    });
    await step("Then the head names the product under the room and counts only the other room's unread", async () => {
      await expect(byId('chat-panel-subtitle')).toHaveTextContent('Market · market.dot');
      await expect(byId('chat-panel-other-unread')).toHaveTextContent('1');
      await expect(byId('chat-panel-back')).toBeVisible();
    });
    await step('When the other room is seen', () => {
      stage.update({ unreadByRoom: { orders: 2 } });
    });
    await step('Then the head shows no unread count', async () => {
      await waitFor(() => expect(document.getElementById('chat-panel-other-unread')).toBeNull());
    });
  },
};

/** As a user of a product with one room, I see Send wait for my text. */
export const SendWaitsForText: Story = {
  beforeEach: () => {
    stage.rooms = [{ roomId: 'courier', name: 'Courier', icon: '', createdAt: 0 }];
    stage.say('courier', textOf('I am two streets away.'), { minutesAgo: 4 });
    stage.say('courier', textOf('Is the gate open?'), { minutesAgo: 4 });
    stage.say('courier', textOf('Code is 4521'), { minutesAgo: 0, author: 'user' });
  },
  play: async ({ userEvent, step }) => {
    const send = await body.findByRole('button', { name: 'Send' });
    await step('Given the conversation with nothing typed, Send is off', async () => {
      await expect(send).toBeDisabled();
    });
    await step('When I type a message', async () => {
      await userEvent.type(body.getByPlaceholderText('Message'), 'Thanks!');
    });
    await step('Then Send is on', async () => {
      await expect(send).toBeEnabled();
    });
  },
};

/** As a reader of a conversation over two days, I see each day named above its first message. */
export const DaysDivided: Story = {
  beforeEach: () => {
    stage.rooms = [{ roomId: 'courier', name: 'Courier', icon: '', createdAt: 0 }];
    stage.say('courier', textOf('I am two streets away.'), { minutesAgo: 24 * 60 });
    stage.say('courier', textOf('Is the gate open?'), { minutesAgo: 24 * 60 });
    stage.say('courier', textOf('Code is 4521'), { minutesAgo: 0, author: 'user' });
  },
  play: async ({ step }) => {
    const list = await conversation();
    await step('Given the conversation shows', async () => {
      await waitFor(() => expect(within(list).getAllByTestId('chat-msg')).toHaveLength(3));
    });
    await step('Then a divider opens each of its two days, the newest today', async () => {
      const days = within(list).getAllByTestId('chat-day');
      await expect(days).toHaveLength(2);
      await expect(at(days, 1)).toHaveTextContent('Today');
      await expect(at(days, 1).nextElementSibling).toHaveTextContent('Code is 4521');
    });
  },
};

/** As a reader of a room whose app chose an empty footer, I see no message box and am told it is read only. */
export const ReadOnlyRoomHasNoComposer: Story = {
  beforeEach: () => {
    stage.seed(2, [textOf('Read only')]);
    stage.rooms = stage.rooms.map(room => (room.roomId === 'r0' ? { ...room, footer: 'Empty' } : room));
  },
  play: async ({ step }) => {
    await step('Given a room whose app chose an empty footer', async () => {
      await openRoom('Room 0', 1);
    });
    await step('Then its conversation shows no message box and says it is read only', async () => {
      await expect(body.getByPlaceholderText('Message')).not.toBeVisible();
      await expect(byId('chat-panel-hint')).toHaveTextContent('This chat is read only.');
    });
  },
};

/** As a reader, I am told when chat cannot be read and the notice goes once reads work again. */
export const ReadFails: Story = {
  beforeEach: () => {
    stage.seed(3);
    stage.contactsFail = true;
  },
  play: async ({ step }) => {
    const hint = await appears('#chat-panel-hint');
    await step('Given the room list cannot be read, the panel says so', async () => {
      await waitFor(() => expect(hint).toBeVisible());
      await expect(hint).toHaveTextContent('Chat could not be loaded');
    });
    await step('When reads work again and the app posts a message, the hint goes', async () => {
      stage.contactsFail = false;
      stage.productSays('r1', 'hello');
      await findRow('Room 1');
      await expect(hint).not.toBeVisible();
    });
    await step('When a conversation cannot be read, the panel says so', async () => {
      stage.messagesFail = true;
      (await findRow('Room 0')).click();
      await waitFor(() => expect(hint).toBeVisible());
      await expect(hint).toHaveTextContent('Chat could not be loaded.');
    });
    await step('When it can be read again and a message arrives, the hint goes', async () => {
      stage.messagesFail = false;
      stage.productSays('r0', 'back');
      await waitFor(() => expect(hint).not.toBeVisible());
      await expect(within(await conversation()).getAllByTestId('chat-msg')).toHaveLength(1);
    });
  },
};

/** As a keyboard user, I keep my focus on a room row when a new message moves it to the top. */
export const MovedRowKeepsFocus: Story = {
  beforeEach: () => {
    stage.seed(5);
  },
  play: async ({ step }) => {
    const oldest = await findRow('Room 0');
    await step('Given focus is on the oldest room, last in the list', async () => {
      await expect(at(rows(), 4)).toBe(oldest);
      oldest.focus();
    });
    await step('When a message makes that room the most recent', async () => {
      stage.productSays('r0', 'news');
      await waitFor(() => expect(at(rows(), 0)).toBe(oldest));
    });
    await step('Then my focus is still on its row', async () => {
      await expect(oldest).toHaveFocus();
    });
  },
};

/** As a reader at the newest message, I stay there when a custom message grows late. */
export const LateCustomRenderStaysAtBottom: Story = {
  beforeEach: () => {
    stage.seed(3, [...FORTY.slice(1), { tag: 'Custom', value: { messageType: 'poll', payload: '0x01' } }]);
  },
  play: async ({ step }) => {
    let list = await conversation();
    await step('Given I am at the newest message, a custom one waiting for its tree', async () => {
      list = await openRoom('Room 0', 40);
      await waitFor(() => expect(stage.renders).toHaveLength(1));
    });
    await step('When its tree arrives and makes the conversation taller', async () => {
      at(stage.renders, 0).sink.onUpdate({
        tag: 'Box',
        value: {
          modifiers: [{ tag: 'Height', value: 300 }],
          props: {},
          children: [{ tag: 'String', value: { text: 'Poll' } }],
        },
      });
      await waitFor(() => expect(list).toHaveTextContent('Poll'));
    });
    await step('Then I stay at the newest message', async () => {
      await waitFor(() => expect(belowView(list)).toBeLessThanOrEqual(1));
    });
  },
};

/**
 * Resolves once a ResizeObserver made after the panel's sees `el` change size, so the panel's own observer has run.
 */
function resized(el: HTMLElement, change: () => void): Promise<void> {
  const before = el.getBoundingClientRect();
  return new Promise(resolve => {
    const observer = new ResizeObserver(([entry]) => {
      const now = entry?.contentRect;
      if (now !== undefined && (now.width !== before.width || now.height !== before.height)) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(el);
    change();
  });
}

/**
 * As a reader at the newest message, I stay there when the panel is resized, and stay off the bottom if I had scrolled
 * up.
 */
export const ResizingKeepsMeAtBottom: Story = {
  beforeEach: () => {
    stage.seed(3, FORTY);
  },
  play: async ({ step }) => {
    let list = await conversation();
    // The drawer's panel, which the window sizes on the page.
    const drawer = byTestId('chat-panel');
    await step('Given I am at the newest message', async () => {
      list = await openRoom('Room 0', 40);
    });
    await step('When the panel gets shorter, I stay at the newest message', async () => {
      await resized(list, () => {
        drawer.style.marginBottom = '200px';
      });
      await expect(belowView(list)).toBeLessThanOrEqual(1);
    });
    await step('When the panel gets narrower and the messages wrap taller, I stay at the newest message', async () => {
      await resized(within(list).getByTestId('chat-panel-thread'), () => {
        drawer.style.width = '240px';
      });
      await expect(belowView(list)).toBeLessThanOrEqual(1);
    });
    await step('When I scroll up and the panel widens, I stay off the bottom', async () => {
      await scrollTo(list, 100);
      await resized(within(list).getByTestId('chat-panel-thread'), () => {
        drawer.style.width = '360px';
      });
      await expect(belowView(list)).toBeGreaterThan(24);
    });
  },
};

/** As a reader, I close the panel and its watch on the conversation's size stops with it. */
export const ClosingStopsTheSizeWatch: Story = {
  beforeEach: () => {
    stage.seed(3, FORTY);
  },
  play: async ({ canvasElement, step }) => {
    let list = await conversation();
    await step('Given I am at the newest message', async () => {
      list = await openRoom('Room 0', 40);
    });
    await step('When the panel closes', async () => {
      stage.update({ open: false });
      await waitFor(() => expect(list.isConnected).toBe(false));
    });
    await step(
      'Then its size watch has stopped, so the old conversation resized no longer pins to the bottom',
      async () => {
        // Put back, shorter than its messages, it grows from nothing and starts at the top, where a watch still
        // running would pin it to the end.
        list.style.height = '200px';
        await resized(list, () => {
          canvasElement.append(list);
        });
        await expect(list.scrollTop).toBe(0);
        list.remove();
      },
    );
  },
};

/** As a reader who scrolled up, I am brought to my own message when I send it. */
export const SendingBringsMeToMine: Story = {
  beforeEach: () => {
    stage.seed(3, FORTY);
  },
  play: async ({ userEvent, step }) => {
    let list = await conversation();
    await step('Given a conversation I scrolled up in', async () => {
      list = await openRoom('Room 0', 40);
      await scrollTo(list, 100);
    });
    await step('When I send a message', async () => {
      await userEvent.type(body.getByPlaceholderText('Message'), 'hi{Enter}');
    });
    await step('Then it shows and I am brought to it', async () => {
      await waitFor(() => expect(within(list).getAllByTestId('chat-msg')).toHaveLength(41));
      await waitFor(() => expect(belowView(list)).toBeLessThanOrEqual(1));
    });
  },
};
