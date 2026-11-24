// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { bindCaptureSink } from '@dotli/metrics';
import { expect, fn, waitFor, within } from 'storybook/test';
import { byId } from '@dotli/ui/testing';
import { expectPhone, TopbarFrame } from '../../testing/stories/topbarFrame.js';
import {
  type ChatStage,
  chatStage,
  seedEveryKind,
  seedShop,
  type StageState,
} from '../../testing/stories/chatFixtures.js';
import { GroupFrame, moreRow, openMore } from '../../testing/stories/frames.js';
import type { ChatPanelModule } from './ChatDock.js';
import { ChatItem } from './ChatButton.js';
import { ChatDock } from './ChatDock.js';

// The topbar's chat button and the chat drawer it opens, on a story's chat.

const SLOW = { timeout: 5000 };
const PHONE = { viewport: { value: 'phone', isRotated: false } };

/** A bot's icon that loads, so its row shows the image and not the letter fallback. */
const ICON =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"%3E%3Crect width="1" height="1" fill="teal"/%3E%3C/svg%3E';

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="chat-room-item"]')];
}

function rowNamed(name: string): HTMLElement {
  const row = rows().find(item => item.textContent.includes(name));
  if (row === undefined) {
    throw new Error(`no room row for ${name}`);
  }
  return row;
}

function openChat(): void {
  byId('chat-button').click();
}

/** The drawer's close button in its wide form. */
function closeButton(): HTMLElement {
  return within(document.body).getByTestId('chat-panel-side-close');
}

async function openRoom(name: string): Promise<void> {
  await waitFor(() => expect(rows().some(row => row.textContent.includes(name))).toBe(true), SLOW);
  rowNamed(name).click();
  await waitFor(() => expect(byId('chat-panel-rooms')).not.toBeVisible());
}

/** Waits for the conversation the panel opens on when the product has one room. */
async function soleRoomShows(): Promise<void> {
  await waitFor(() => expect(byId('chat-panel-messages')).toBeVisible(), SLOW);
}

function send(text: string): void {
  const input = byId('chat-panel-input') as HTMLInputElement;
  input.value = text;
  (byId('chat-panel-composer') as HTMLFormElement).requestSubmit();
}

let chunkCalls = 0;

/** The chat code's chunk, which cannot load. */
function loadMissingPanel(): Promise<ChatPanelModule> {
  chunkCalls += 1;
  return Promise.reject(new Error('chunk failed'));
}

/** The story's chat, fresh for each. */
let stage: ChatStage = chatStage();

const meta = {
  title: 'Host/Chat/ChatDock',
  component: ChatDock,
  args: stage.dock,
  beforeEach: () => {
    stage = chatStage();
    return stage.dispose;
  },
  render: () => (
    <>
      <ChatItem {...stage.button} />
      <ChatDock {...stage.dock} />
    </>
  ),
} satisfies Meta<typeof ChatDock>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Opens the drawer on a shop's product, as each story of a canvas state starts. */
function openShop(patch: Partial<StageState> = {}): void {
  stage.update({ open: true, productName: 'Market', ...patch });
}

/** The shop's one room, the default, holding every kind of message. */
function seedOneRoom(): void {
  stage.rooms = [{ roomId: 'market', name: 'Market', icon: '', createdAt: 0 }];
  seedEveryKind(stage, 'market');
}

/** As a user of a product with one room, I see the drawer open on its conversation, with every kind of message. */
export const OneRoom: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    seedOneRoom();
    openShop();
  },
};

/** As a phone user of a product with one room, I see the sheet open on its conversation. */
export const OneRoomOnPhone: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
  beforeEach: () => {
    seedOneRoom();
    openShop();
  },
};

/** As a user of a product with several rooms, I see the drawer open on their list, with each room's kind, time and unread. */
export const Rooms: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    seedShop(stage);
    openShop();
  },
};

/**
 * As a user, I see a room opened from the list in the drawer, under a head that names it and the product, with a way
 * back to the list and what the other rooms hold unread.
 */
export const RoomOpen: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    seedShop(stage);
    openShop({ activeRoomId: 'orders' });
  },
  play: async ({ step }) => {
    await step('Given the open room has unread messages of its own and one other room has one', async () => {
      await waitFor(() => expect(byId('chat-panel-title')).toHaveTextContent('Market orders'), SLOW);
    });
    await step("Then the head names the product under the room and counts only the other room's unread", async () => {
      await expect(byId('chat-panel-subtitle')).toHaveTextContent('Market');
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

/** As a phone user of a product with several rooms, I see the sheet open on their list. */
export const RoomsOnPhone: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
  beforeEach: () => {
    seedShop(stage);
    openShop();
  },
};

/** As a user, I see a waiting hint while the room list is empty. */
export const EmptyRoomListHint: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('As a user, an empty room list shows a waiting hint', async () => {
      // When
      openChat();

      // Then
      await waitFor(() => expect(byId('chat-panel-hint')).toBeVisible(), SLOW);
      await expect(byId('chat-panel-hint')).toHaveTextContent('Waiting for the app to start a chat.');
      await expect(byId('chat-panel')).toBeVisible();
      await expect(byId('chat-panel-composer')).not.toBeVisible();
    });
  },
};

/**
 * As a user of a product with one room, I land in its conversation with the keyboard down, and a second room lets me go
 * back to the list.
 */
export const OneRoomOpensOnItsConversation: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('Given a product with one room', () => {
      stage.createRoom('main', 'Main');
      stage.productSays('main', 'hello from the app');
    });
    await step('When I open the chat', async () => {
      openChat();
      await soleRoomShows();
    });
    await step(
      'Then its conversation shows, open, with focus on the drawer, no head of its own, no room list and no way back',
      async () => {
        await waitFor(() => expect(byId('chat-panel-messages')).toHaveTextContent('hello from the app'), SLOW);
        await expect(document.getElementById('chat-panel-title')).toBeNull();
        await expect(stage.state.get().activeRoomId).toBe('main');
        await expect(within(document.body).getByTestId('chat-panel')).toHaveFocus();
        await expect(byId('chat-panel-rooms')).not.toBeVisible();
        await expect(document.getElementById('chat-panel-back')).toBeNull();
      },
    );
    await step('When a second room appears', () => {
      stage.createRoom('news', 'News');
    });
    await step('Then I stay in the conversation, under a head that names it, and can go back', async () => {
      await waitFor(() => expect(document.getElementById('chat-panel-back')).toBeVisible(), SLOW);
      await expect(byId('chat-panel-title')).toHaveTextContent('Main');
      await expect(byId('chat-panel-messages')).toBeVisible();
    });
    await step('When I go back', () => {
      byId('chat-panel-back').click();
    });
    await step('Then the list shows both rooms', async () => {
      await waitFor(() => expect(rows()).toHaveLength(2), SLOW);
    });
  },
};

/** As a user, I read product messages and my replies reach the product. */
export const MessagesRenderAndRepliesPublish: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('As a user, product messages render and replies reach the product', async () => {
      // Given
      stage.createRoom('main', 'Main');
      stage.productSays('main', 'hello from the app');

      // When
      openChat();
      await soleRoomShows();

      // Then
      await waitFor(() => expect(byId('chat-panel-messages')).toHaveTextContent('hello from the app'), SLOW);
      const time = document.querySelector<HTMLTimeElement>('[data-testid="chat-msg-time"]');
      await expect(time).toHaveTextContent('just now');
      await expect(time?.title).not.toBe('');

      // When
      send('hello back');

      // Then
      await waitFor(() => expect(stage.published).toEqual([{ roomId: 'main', text: 'hello back' }]), SLOW);
      await waitFor(() => expect(byId('chat-panel-messages')).toHaveTextContent('hello back'));
    });
  },
};

/** As a reader, I see one time under a run of messages an author sent within a minute. */
export const OneTimePerRun: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('As a reader, a run of messages shows its time once, under its last message', async () => {
      // Given
      stage.createRoom('main', 'Main');
      stage.productSays('main', 'first');
      stage.productSays('main', 'second');

      // When
      openChat();
      await soleRoomShows();
      send('mine');

      // Then
      await waitFor(() => expect(byId('chat-panel-messages')).toHaveTextContent('mine'), SLOW);
      const messages = [...document.querySelectorAll<HTMLElement>('[data-testid="chat-msg"]')];
      await expect(messages.map(message => message.querySelector('[data-testid="chat-msg-time"]') !== null)).toEqual([
        false,
        true,
        true,
      ]);
    });
  },
};

/** As a user, I see bots and rooms in one list ordered by last message time. */
export const BotsAndRoomsByLastMessage: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('As a user, bots and rooms share one list ordered by last message time', async () => {
      // Given
      stage.createRoom('first', 'First');
      stage.createRoom('second', 'Second');
      stage.createRoom('idle', 'Idle');
      stage.registerBot('echo', 'Echo Bot', ICON);
      stage.productSays('second', 'older');
      stage.productSays('first', 'newer');

      // When
      openChat();
      await waitFor(() => expect(rows()).toHaveLength(4), SLOW);

      // Then one recency order across rooms and bots, falling back to creation time for contacts without messages
      const names = (): string[] =>
        rows().map(row => row.querySelector('[data-testid="chat-room-name"]')?.textContent ?? '');
      await expect(names()).toEqual(['First', 'Second', 'Echo Bot', 'Idle']);
      await expect(rowNamed('Echo Bot').querySelector('img[data-testid="chat-room-icon"]')).toHaveAttribute(
        'src',
        ICON,
      );

      // When
      await openRoom('Echo Bot');

      // Then
      await expect(byId('chat-panel-title')).toHaveTextContent('Echo Bot');
      await expect(byId('chat-panel-composer')).toBeVisible();

      // When a bot messages the user by posting with its botId as the roomId
      stage.productSays('echo', 'hi, I am the bot');

      // Then
      await waitFor(() => expect(byId('chat-panel-messages')).toHaveTextContent('hi, I am the bot'), SLOW);
      const botMessage = byId('chat-panel-messages').querySelector('[data-testid="chat-msg"]');
      await expect([...(botMessage?.children ?? [])].map(child => child.getAttribute('data-testid'))).toEqual([
        'chat-msg-bubble',
        'chat-msg-time',
      ]);

      // When
      byId('chat-panel-back').click();

      // Then
      await waitFor(() => expect(names()).toEqual(['Echo Bot', 'First', 'Second', 'Idle']), SLOW);
    });
  },
};

/** As a user, a custom message asks the product to render, a tap on it reaches the product and leaving the room disposes the render. */
export const CustomMessageTreeAndTaps: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('As a user, custom messages render live trees and taps reach the product', async () => {
      // Given
      stage.createRoom('main', 'Main');
      stage.createRoom('other', 'Other');
      stage.productSays('main', { tag: 'Custom', value: { messageType: 'poll', payload: '0x0102' } });
      const messageId = stage.messages[0]?.messageId;

      // When
      openChat();
      await openRoom('Main');
      await waitFor(() => expect(stage.renders).toHaveLength(1), SLOW);

      // Then
      const context = { tag: 'ChatMessage', value: { roomId: 'main', messageId, messageType: 'poll' } };
      await expect(stage.renders[0]?.request).toEqual({ context, payload: '0x0102' });

      // When the product renders its tree
      stage.renders[0]?.sink.onUpdate({
        tag: 'Column',
        value: {
          modifiers: [],
          props: {},
          children: [
            {
              tag: 'Text',
              value: { modifiers: [], props: {}, children: [{ tag: 'String', value: { text: 'Pick one' } }] },
            },
            {
              tag: 'Button',
              value: { modifiers: [], props: { text: 'Option A', enabled: true, clickAction: 'pick:a' }, children: [] },
            },
          ],
        },
      });

      // Then
      await waitFor(() => expect(byId('chat-panel-messages')).toHaveTextContent('Pick one'));

      // When tapping the rendered button, which publishes a renderer action and no chat action
      document.querySelector<HTMLButtonElement>('[data-testid="chat-custom-btn"]')?.click();

      // Then
      await waitFor(() => expect(stage.rendererActions).toEqual([{ context, actionId: 'pick:a', payload: '0x' }]));
      await expect(stage.actions).toHaveLength(0);
      await expect(stage.published).toHaveLength(0);

      // When
      byId('chat-panel-back').click();

      // Then
      await waitFor(() => expect(stage.disposedRenders()).toBe(1));
    });
  },
};

/** As a user, I see each room's unread count on its row and the total on the chat button. */
export const PerRoomUnreadUntilOpened: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step("As a user, I see each room's unread count on its row and the total on the chat button", async () => {
      // Given
      stage.createRoom('busy', 'Busy');
      stage.createRoom('quiet', 'Quiet');
      stage.productSays('busy', 'one');
      stage.productSays('busy', 'two');
      stage.update({ unread: 2, unreadByRoom: { busy: 2 } });

      // Then the topbar badge shows the page's sum across rooms
      await waitFor(() => expect(byId('chat-unread-badge')).toHaveTextContent('2'), SLOW);

      // When
      openChat();
      await waitFor(() => expect(rows()).toHaveLength(2), SLOW);

      // Then
      const roomBadges = document.querySelectorAll('[data-testid="chat-room-unread"]');
      await expect(roomBadges).toHaveLength(1);
      await expect(roomBadges[0]).toHaveTextContent('2');
      await expect(rowNamed('Busy').querySelector('[data-testid="chat-room-unread"]')).not.toBeNull();

      // When a message for another room arrives while Busy is open, which the page counts and marks Busy seen
      await openRoom('Busy');
      stage.productSays('quiet', 'psst');
      stage.update({ unread: 1, unreadByRoom: { quiet: 1 } });
      byId('chat-panel-back').click();

      // Then Quiet lists first with the newest message, carrying the unread it got while Busy was open
      await waitFor(
        () =>
          expect(rows().map(row => row.querySelector('[data-testid="chat-room-unread"]')?.textContent ?? '')).toEqual([
            '1',
            '',
          ]),
        SLOW,
      );

      // When
      closeButton().click();

      // Then
      await waitFor(() => expect(byId('chat-unread-badge')).toBeVisible());
      await expect(byId('chat-unread-badge')).toHaveTextContent('1');
    });
  },
};

/** As a keyboard user, I press Escape to close the panel and focus returns to the chat button. */
export const EscapeClosesAndRefocusesButton: Story = {
  tags: ['!autodocs'],
  play: async ({ step, userEvent }) => {
    await step('As a user, Escape closes the panel and returns focus to the chat button', async () => {
      // Given
      openChat();
      await waitFor(() => expect(closeButton()).toBeVisible(), SLOW);
      closeButton().focus();

      // When
      await userEvent.keyboard('{Escape}');

      // Then
      await waitFor(() => expect(byId('chat-panel')).not.toBeVisible());
      await expect(byId('chat-button')).toHaveFocus();
    });
  },
};

/** As a user, I see a failed reply keep my message and show why it failed. */
export const FailedReplyKeepsMessage: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('As a user, a failed reply keeps the message and shows why', async () => {
      // Given
      stage.sendError = new Error('boom');
      stage.createRoom('main', 'Main');
      openChat();
      await soleRoomShows();

      // When
      send('again');

      // Then
      await waitFor(
        () => expect(byId('chat-panel-hint')).toHaveTextContent('Message saved, but the app could not be reached.'),
        SLOW,
      );
      await waitFor(() => expect(byId('chat-panel-messages')).toHaveTextContent('again'));
    });
  },
};

/** As a user whose reply could not be kept, such as with no live connection or a failed store, I keep my text. */
export const UnkeptReplyKeepsText: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('As a user, a reply that was not kept stays in the composer', async () => {
      // Given
      stage.refuseError = new Error('IndexedDB is gone');
      stage.createRoom('main', 'Main');
      openChat();
      await soleRoomShows();

      // When
      send('hello');

      // Then
      await waitFor(() => expect(byId('chat-panel-hint')).toHaveTextContent('Message not sent. Try again.'), SLOW);
      await expect(byId('chat-panel-input')).toHaveValue('hello');
      await expect(byId('chat-panel-messages')).not.toHaveTextContent('hello');
    });
  },
};

/** As a keyboard user, I open a room and focus lands in the composer. */
export const OpeningRoomFocusesComposer: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('As a user, opening a room focuses the composer', async () => {
      // Given
      stage.createRoom('main', 'Main');
      stage.createRoom('other', 'Other');
      openChat();

      // When
      await openRoom('Main');

      // Then
      await waitFor(() => expect(byId('chat-panel-input')).toHaveFocus());
    });
    await step('As a user, a room with no messages says so', async () => {
      // Then
      await expect(byId('chat-panel-hint')).toHaveTextContent('No messages yet.');
    });
  },
};

/** As a user, I see a render error close the panel and the next open recovers it. */
export const RenderErrorClosesThenRecovers: Story = {
  tags: ['!autodocs'],
  beforeEach: () => bindCaptureSink({ exception: fn(), expected: fn() }),
  play: async ({ step }) => {
    await step('As a user, a render error closes the panel and the next open recovers it', async () => {
      // Given a session the empty room list cannot read the first time, which its hint shows
      let thrown = false;
      stage.conversation.loggedIn = () => {
        if (!thrown) {
          thrown = true;
          throw new Error('render boom');
        }
        return true;
      };

      // When
      openChat();

      // Then
      await waitFor(() => expect(thrown).toBe(true), SLOW);
      await waitFor(() => expect(byId('chat-panel')).not.toBeVisible());

      // When
      openChat();

      // Then
      await waitFor(() => expect(byId('chat-panel-hint')).toBeVisible(), SLOW);
      await expect(byId('chat-panel-hint')).toHaveTextContent('Waiting for the app to start a chat.');
    });
  },
};

/** As a user, I find the panel closed when the chat code cannot load, and the next open retries. */
export const ChunkLoadFailureRetries: Story = {
  tags: ['!autodocs'],
  render: () => (
    <>
      <ChatItem {...stage.button} />
      <ChatDock {...stage.dock} loadPanel={loadMissingPanel} />
    </>
  ),
  beforeEach: () => {
    chunkCalls = 0;
    return bindCaptureSink({ exception: fn(), expected: fn() });
  },
  play: async ({ step }) => {
    await step('As a user, if the chat code cannot load, the panel closes and the next open retries', async () => {
      // When
      openChat();

      // Then
      await waitFor(() => expect(chunkCalls).toBeGreaterThanOrEqual(1), SLOW);
      await waitFor(() => expect(byId('chat-panel')).not.toBeVisible());
      const before = chunkCalls;

      // When
      openChat();

      // Then
      await waitFor(() => expect(chunkCalls).toBe(before + 1), SLOW);
      await waitFor(() => expect(byId('chat-panel')).not.toBeVisible());
    });
  },
};

/** As a user, I see the unread count on the chat button while the panel is closed and press it to toggle the panel. */
export const PressTogglesPanel: Story = {
  tags: ['!autodocs'],
  parameters: { chrome: true },
  beforeEach: () => {
    stage.update({ available: false });
  },
  render: () => (
    <>
      <TopbarFrame>
        <ChatItem {...stage.button} />
      </TopbarFrame>
      <ChatDock {...stage.dock} />
    </>
  ),
  play: async ({ step }) => {
    await step(
      'As a user, the button carries the unread count while the panel is closed and toggles the panel, saying whether it is open',
      async () => {
        // Given
        stage.update({ available: true, unread: 3 });
        await waitFor(() => expect(byId('chat-button')).toHaveAttribute('aria-label', 'Chat, 3 unread'));
        await expect(byId('chat-unread-badge')).toHaveTextContent('3');
        await expect(byId('chat-button')).toHaveAttribute('aria-expanded', 'false');

        // When
        byId('chat-button').click();

        // Then
        await waitFor(() => expect(byId('chat-panel')).toBeVisible());
        await expect(byId('chat-button')).toHaveAttribute('aria-expanded', 'true');

        // When
        byId('chat-button').click();

        // Then
        await waitFor(() => expect(byId('chat-panel')).not.toBeVisible());
        await expect(byId('chat-button')).toHaveAttribute('aria-expanded', 'false');
      },
    );
  },
};

/** As a phone user, the chat button collapsed into More opens the panel from its row. */
export const MoreRowOpensPanel: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
  parameters: { chrome: true },
  render: () => (
    <>
      <GroupFrame room={40}>
        <ChatItem {...stage.button} />
      </GroupFrame>
      <ChatDock {...stage.dock} />
    </>
  ),
  play: async ({ userEvent, step }) => {
    await expectPhone(step);
    await step('When I open More', async () => {
      await openMore(userEvent);
    });
    await step('Then the chat button collapsed into More as its Chat row', async () => {
      await expect(moreRow('chat')).toHaveTextContent('Chat');
    });
    await step('When I choose the Chat row', async () => {
      await userEvent.click(moreRow('chat'));
    });
    await step('Then the panel is open and More is closed', async () => {
      await waitFor(() => expect(byId('chat-panel')).toBeVisible());
      await expect(byId('chat-button')).toHaveAttribute('aria-expanded', 'true');
      await expect(document.getElementById('more-popover')).not.toHaveAttribute('data-open');
    });
  },
};
