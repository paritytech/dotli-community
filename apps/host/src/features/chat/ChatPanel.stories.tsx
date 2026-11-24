// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onCleanup, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ChatMessageContent } from '@parity/truapi';
import { createJSXDecorator, type Meta, type StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { Drawer } from '@dotli/ui';
import { byId } from '@dotli/ui/testing';
import {
  type ChatSeed,
  type ChatStage,
  chatStage,
  everyKindIn,
  SHOP_CHAT,
  type StoryMessage,
} from '../../testing/stories/chatFixtures.js';
import type { ChatRoom } from './chat.js';
import { ChatPanel } from './ChatPanel.js';

/** The chat of the story on show, which its panel built from the args. */
let stage: ChatStage = chatStage();

/** One room the courier writes in, yesterday and today. */
const COURIER: ChatSeed = {
  rooms: [{ roomId: 'courier', name: 'Courier', icon: '', createdAt: 0 }],
  messages: [
    say('courier', 'I am two streets away.', 24 * 60),
    say('courier', 'Is the gate open?', 24 * 60),
    { ...say('courier', 'Code is 4521', 0), author: 'user' },
  ],
  unreadByRoom: {},
};

// The drawer renders into the body, outside the story's canvas.
const body = within(document.body);

// In the drawer the page opens the panel in, filled as the page's dock fills it, with a close button a play can press.
const inDrawer = createJSXDecorator(Story => {
  const [open, setOpen] = createSignal(true);
  return (
    <Drawer open={open()} onOpenChange={setOpen} title="Chat" testId="chat-panel">
      <div
        style={{
          display: 'flex',
          'flex-direction': 'column',
          'box-sizing': 'border-box',
          height: '100%',
          background: 'var(--chat-bg-panel)',
          'color-scheme': 'dark',
        }}
      >
        <Story />
      </div>
    </Drawer>
  );
});

const meta = {
  title: 'Host/Chat/ChatPanel',
  component: StoryChatPanel,
  args: SHOP_CHAT,
  parameters: { chrome: true },
  // The drawer covers the page it opens on, so it has no docs block.
  tags: ['!autodocs'],
  decorators: [inDrawer],
} satisfies Meta<typeof StoryChatPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user of a product with several rooms, I see their list, with each room's kind, time and unread. */
export const Default: Story = {};

/**
 * As a user of a product with one room, I see the drawer open on its conversation, with every kind of message and one
 * kind the page does not know.
 */
export const OneRoom: Story = {
  args: {
    rooms: [{ roomId: 'market', name: 'Market', icon: '', createdAt: 0 }],
    messages: everyKindIn('market'),
    unreadByRoom: {},
  },
};

/** As a reader of a conversation over two days, I see each day named above its first message. */
export const DaysDivided: Story = {
  args: COURIER,
};

/** As a user, I see the chat loading before its rooms are read. */
export const Loading: Story = {
  args: { readsHeld: true },
};

/** As a user of a product that has started no chat, I am told the app has not started one yet. */
export const NoRooms: Story = {
  args: { rooms: [], messages: [], unreadByRoom: {} },
};

/** As a logged-out user, I am told chat opens once I log in. */
export const LoggedOut: Story = {
  args: { ...NoRooms.args, loggedIn: false },
};

/** As a user, I am told when the room list cannot be read. */
export const RoomsFailed: Story = {
  args: { contactsFail: true },
};

/** As a user, I see a room with no messages say so. */
export const NoMessages: Story = {
  args: {
    rooms: [...(SHOP_CHAT.rooms ?? []), { roomId: 'returns', name: 'Returns', icon: '', createdAt: 0 }],
    activeRoomId: 'returns',
  },
};

/** As a user whose message did not send, I am told so above the composer. */
export const SendFailed: Story = {
  args: { activeRoomId: 'courier', composerError: 'Message not sent. Try again.' },
};

/** As a user, I find a room the app keeps read only shows no message box. */
export const ReadOnlyRoom: Story = {
  args: { activeRoomId: 'promos' },
  play: async ({ step }) => {
    await step('Given the read-only room is open', async () => {
      await waitFor(() => expect(body.getByRole('log', { name: 'Messages' })).toBeVisible());
    });
    await step('Then I find no message box', async () => {
      await expect(body.queryByRole('textbox')).toBeNull();
    });
  },
};

/** As a user of a product with one room, I see Send wait for my text. */
export const SendWaitsForText: Story = {
  args: COURIER,
  play: async ({ userEvent, step }) => {
    const send = await body.findByRole('button', { name: 'Send' });
    await step('Given the conversation with nothing typed, Send is off', async () => {
      await expect(send).toBeDisabled();
    });
    await step('When I type a message', async () => {
      await userEvent.type(body.getByRole('textbox'), 'Thanks!');
    });
    await step('Then Send is on', async () => {
      await expect(send).toBeEnabled();
    });
  },
};

/** As a keyboard user, I open a room from the list and focus lands in its message box. */
export const OpeningRoomFocusesComposer: Story = {
  play: async ({ userEvent, step }) => {
    await step('When I open the courier room from the list', async () => {
      await userEvent.click(await body.findByRole('button', { name: /Courier/ }));
    });
    await step('Then its message box has focus', async () => {
      await waitFor(() => expect(body.getByRole('textbox')).toHaveFocus());
    });
  },
};

/** As a user whose reply was kept but could not reach the app, I see it stay in the conversation and am told so. */
export const UndeliveredReplyStays: Story = {
  args: { ...COURIER, sendError: new Error('the app is gone') },
  play: async ({ userEvent, step }) => {
    await step('When I send a reply the app cannot get', async () => {
      await userEvent.type(await body.findByRole('textbox'), 'again{Enter}');
    });
    await step('Then it stays in the conversation and the panel tells me', async () => {
      await waitFor(() => expect(messages()).toHaveLength(4));
      await waitFor(() => expect(byId('chat-panel-hint')).toBeVisible());
    });
  },
};

/** As a user whose reply could not be kept, such as with no live connection or a failed store, I keep my text. */
export const UnkeptReplyKeepsText: Story = {
  args: { ...COURIER, refuseError: new Error('IndexedDB is gone') },
  play: async ({ userEvent, step }) => {
    const input = await body.findByRole('textbox');
    await step('When I send a reply that cannot be kept', async () => {
      await userEvent.type(input, 'hello{Enter}');
    });
    await step('Then my text is back in the message box and the conversation has no new message', async () => {
      await waitFor(() => expect(input).toHaveValue('hello'));
      await expect(messages()).toHaveLength(3);
    });
  },
};

/** As a user, I see the rooms once the list can be read again, and the notice that it could not goes. */
export const RoomListRecovers: Story = {
  args: { contactsFail: true },
  play: async ({ step }) => {
    await step('Given the room list cannot be read', async () => {
      await waitFor(() => expect(byId('chat-panel-hint')).toBeVisible());
    });
    await step('When reads work again and the app posts a message', () => {
      stage.contactsFail = false;
      stage.productSays('courier', 'back');
    });
    await step('Then the rooms show and the notice goes', async () => {
      await expect(await body.findByRole('list', { name: 'Chat rooms' })).toBeVisible();
      await expect(byId('chat-panel-hint')).not.toBeVisible();
    });
  },
};

/** As a reader, I see the conversation once it can be read again, and the notice that it could not goes. */
export const ConversationRecovers: Story = {
  args: { ...COURIER, messagesFail: true },
  play: async ({ step }) => {
    await step('Given the conversation cannot be read', async () => {
      await waitFor(() => expect(byId('chat-panel-hint')).toBeVisible());
    });
    await step('When reads work again and a message arrives', () => {
      stage.messagesFail = false;
      stage.productSays('courier', 'back');
    });
    await step('Then its messages show and the notice goes', async () => {
      await waitFor(() => expect(messages()).toHaveLength(4));
      await expect(byId('chat-panel-hint')).not.toBeVisible();
    });
  },
};

/** As a keyboard user, I keep my focus on a room row when a new message moves it to the top. */
export const MovedRowKeepsFocus: Story = {
  args: { rooms: rooms(5), messages: [], unreadByRoom: {} },
  play: async ({ step }) => {
    const rows = (): HTMLElement[] => within(body.getByRole('list', { name: 'Chat rooms' })).getAllByRole('button');
    const oldest = await body.findByRole('button', { name: /Room 0/ });
    await step('Given focus is on the oldest room, last in the list', async () => {
      await waitFor(() => expect(rows().at(-1)).toBe(oldest));
      oldest.focus();
    });
    await step('When a message makes that room the most recent', async () => {
      stage.productSays('r0', 'news');
      await waitFor(() => expect(rows()[0]).toBe(oldest));
    });
    await step('Then my focus is still on its row', async () => {
      await expect(oldest).toHaveFocus();
    });
  },
};

/** The panel on a chat that holds what the args say as the panel mounts. The toolbar's remount applies new args. */
function StoryChatPanel(props: ChatSeed): JSX.Element {
  const chat = untrack(() => chatStage({ ...props }));
  stage = chat;
  onCleanup(chat.dispose);
  return <ChatPanel conversation={chat.conversation} />;
}

function textOf(text: string): ChatMessageContent {
  return { tag: 'Text', value: { text } };
}

function say(roomId: string, text: string, minutesAgo: number): StoryMessage {
  return { roomId, content: textOf(text), minutesAgo };
}

/** Rooms r0 to r(count - 1), the newest last. */
function rooms(count: number): ChatRoom[] {
  return Array.from({ length: count }, (_, i) => ({
    roomId: `r${String(i)}`,
    name: `Room ${String(i)}`,
    icon: '',
    createdAt: i,
  }));
}

function messages(): HTMLElement[] {
  return within(body.getByRole('log', { name: 'Messages' })).getAllByTestId('chat-msg');
}
