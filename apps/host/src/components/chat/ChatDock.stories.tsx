// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { bindCaptureSink } from '@dotli/metrics';
import { expect, fn, waitFor } from 'storybook/test';
import { byId } from '@dotli/ui/testing';
import { expectPhone, TopbarFrame } from '../../../.storybook/topbar-frame.js';
import { type ChatStage, chatStage } from '../../../.storybook/chat-fixtures.js';
import { GroupFrame, moreRow, openMore } from '../../../.storybook/frames.js';
import type { ChatPanelModule } from '../../lazy.js';
import { ChatItem } from './ChatButton.js';
import { ChatDock } from './ChatDock.js';

// The topbar's chat button over the docked panel, on a story's chat.

const SLOW = { timeout: 5000 };

/** A one-pixel PNG, as a real browser drops an icon it cannot decode for the letter fallback. */
const ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

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

async function openRoom(name: string): Promise<void> {
  await waitFor(() => expect(rows().some(row => row.textContent.includes(name))).toBe(true), SLOW);
  rowNamed(name).click();
  await waitFor(() => expect(byId('chat-panel-rooms')).not.toBeVisible());
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

export const RoomsWithIconAndName: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step(
      'As a user, opening the panel lists rooms with icon and name, and a room opens and goes back',
      async () => {
        // Given
        stage.createRoom('support', 'Support', ICON);
        stage.createRoom('general', 'General');

        // When
        openChat();
        await waitFor(() => expect(rows()).toHaveLength(2), SLOW);

        // Then
        await expect(byId('chat-panel-composer')).not.toBeVisible();
        const [general, support] = rows();
        await expect(support).toHaveTextContent('Support');
        await expect(support?.querySelector('img[data-testid="chat-room-icon"]')).toHaveAttribute('src', ICON);
        await expect(general?.querySelector('[data-testid="chat-room-icon"][data-fallback]')).toHaveTextContent('G');

        // When
        await openRoom('Support');

        // Then
        await expect(byId('chat-panel-title')).toHaveTextContent('Support');
        await expect(byId('chat-panel-back')).toBeVisible();
        await expect(byId('chat-panel-composer')).toBeVisible();

        // When
        byId('chat-panel-back').click();

        // Then
        await waitFor(() => expect(byId('chat-panel-rooms')).toBeVisible());
        await expect(byId('chat-panel-back')).not.toBeVisible();
      },
    );
  },
};

export const StretchesWhenTopbarHides: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('As a user, the panel stretches to the top when the topbar hides', async () => {
      // When
      stage.update({ topbarHidden: true });

      // Then
      await waitFor(() => expect(byId('chat-panel')).toHaveAttribute('data-topbar-hidden'));

      // When
      stage.update({ topbarHidden: false });

      // Then
      await waitFor(() => expect(byId('chat-panel')).not.toHaveAttribute('data-topbar-hidden'));
    });
  },
};

export const MessagesRenderAndRepliesPublish: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('As a user, product messages render and replies reach the product', async () => {
      // Given
      stage.createRoom('main', 'Main');
      stage.productSays('main', 'hello from the app');

      // When
      openChat();
      await openRoom('Main');

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
      ]);

      // When
      byId('chat-panel-back').click();

      // Then
      await waitFor(() => expect(names()).toEqual(['Echo Bot', 'First', 'Second', 'Idle']), SLOW);
    });
  },
};

export const CustomMessageTreeAndTaps: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('As a user, custom messages render live trees and taps reach the product', async () => {
      // Given
      stage.createRoom('main', 'Main');
      stage.productSays('main', { tag: 'Custom', value: { messageType: 'poll', payload: '0x0102' } });
      const messageId = stage.messages[0]?.messageId;

      // When
      openChat();
      await openRoom('Main');
      await waitFor(() => expect(stage.renders).toHaveLength(1), SLOW);

      // Then
      const context = { tag: 'ChatMessage', value: { roomId: 'main', messageId, messageType: 'poll' } };
      await expect(stage.renders[0]?.request).toEqual({ context, payload: '0x0102' });
      await expect(byId('chat-panel-messages')).toHaveTextContent('Loading…');

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

      // When the render fails, which must not leave a partial tree standing
      stage.renders[0]?.sink.onError?.(new Error('render refused'));

      // Then
      await waitFor(() => expect(byId('chat-panel-messages')).not.toHaveTextContent('Pick one'));
      await expect(byId('chat-panel-messages')).toHaveTextContent('This message can’t be shown right now.');

      // When
      byId('chat-panel-back').click();

      // Then
      await waitFor(() => expect(stage.disposedRenders()).toBe(1));
    });
  },
};

export const UnreadBadge: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('As a user, unseen product messages show an unread badge until I open the panel', async () => {
      // When the page counts a product message I have not seen
      stage.update({ unread: 1, unreadByRoom: { main: 1 } });

      // Then
      await waitFor(() => expect(byId('chat-unread-badge')).toBeVisible(), SLOW);
      await expect(byId('chat-unread-badge')).toHaveTextContent('1');
      await expect(byId('chat-button')).toHaveAccessibleName('Chat, 1 unread');

      // When
      openChat();

      // Then
      await waitFor(() => expect(byId('chat-unread-badge')).not.toBeVisible());
    });
  },
};

export const PerRoomUnreadUntilOpened: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('As a user, each room shows its own unread count until I open it', async () => {
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
      byId('chat-panel-close').click();

      // Then
      await waitFor(() => expect(byId('chat-unread-badge')).toBeVisible());
      await expect(byId('chat-unread-badge')).toHaveTextContent('1');
    });
  },
};

export const EscapeClosesAndRefocusesButton: Story = {
  tags: ['!autodocs'],
  play: async ({ step, userEvent }) => {
    await step('As a user, Escape closes the panel and returns focus to the chat button', async () => {
      // Given
      openChat();
      await waitFor(() => expect(byId('chat-panel-close')).toBeVisible(), SLOW);
      byId('chat-panel-close').focus();

      // When
      await userEvent.keyboard('{Escape}');

      // Then
      await waitFor(() => expect(byId('chat-panel')).not.toBeVisible());
      await expect(byId('chat-button')).toHaveFocus();
    });
  },
};

export const FailedReplyKeepsMessage: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('As a user, a failed reply keeps the message and shows why', async () => {
      // Given
      stage.sendError = new Error('request denied');
      stage.createRoom('main', 'Main');
      openChat();
      await openRoom('Main');

      // When
      send('hello');

      // Then the hint shows as soon as the send fails, and the thread keeps the message
      await waitFor(() => expect(byId('chat-panel-hint')).toHaveTextContent('Log in to chat with this app.'), SLOW);
      await waitFor(() => expect(byId('chat-panel-messages')).toHaveTextContent('hello'));

      // When
      stage.sendError = new Error('boom');
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

export const OpeningRoomFocusesComposer: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('As a user, opening a room focuses the composer', async () => {
      // Given
      stage.createRoom('main', 'Main');
      openChat();

      // When
      await openRoom('Main');

      // Then
      await waitFor(() => expect(byId('chat-panel-input')).toHaveFocus());
    });
  },
};

export const RenderErrorClosesThenRecovers: Story = {
  tags: ['!autodocs'],
  beforeEach: () => bindCaptureSink({ exception: fn(), expected: fn() }),
  play: async ({ step }) => {
    await step('As a user, a render error closes the panel and the next open recovers it', async () => {
      // Given a product whose published name cannot be read the first time, which the panel title reads with no room open
      let thrown = false;
      stage.conversation.productName = () => {
        if (!thrown) {
          thrown = true;
          throw new Error('render boom');
        }
        return 'Broken render';
      };

      // When
      openChat();

      // Then
      await waitFor(() => expect(thrown).toBe(true), SLOW);
      await waitFor(() => expect(byId('chat-panel')).not.toBeVisible());

      // When
      openChat();

      // Then
      await waitFor(() => expect(byId('chat-panel-close')).toBeVisible(), SLOW);
      await expect(byId('chat-panel-title')).toHaveTextContent('Broken render');
    });
  },
};

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
    await step('As a user, a logout that takes chat away hides the button and the panel', async () => {
      // Given
      byId('chat-button').click();
      await waitFor(() => expect(byId('chat-panel')).toBeVisible());

      // When I log out, which takes chat away and closes the panel on the page
      stage.update({ available: false, open: false, loggedIn: false });

      // Then
      await waitFor(() => expect(byId('chat-button')).not.toBeVisible());
      await expect(byId('chat-panel')).not.toBeVisible();
    });
  },
};

/** As a phone user, the chat button collapsed into More opens the panel from its row. */
export const MoreRowOpensPanel: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
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
