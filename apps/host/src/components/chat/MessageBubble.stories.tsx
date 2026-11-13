// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, within } from 'storybook/test';
import type { ChatMessageRecord } from '../../runtime/chat/createChatStore.js';
import { MessageBubble } from './MessageBubble.js';

const NOW = 1_700_000_000_000;

function record(content: unknown, author: 'product' | 'user' = 'product'): ChatMessageRecord {
  return {
    seq: 1,
    productId: 'app.dot',
    roomId: 'main',
    messageId: 'm1',
    author,
    content,
    timestamp: NOW - 5 * 60_000,
  };
}

/** The page's custom body, standing in for the product's live render. */
function customBody() {
  return <div data-testid="chat-custom-root">poll</div>;
}

const meta = {
  title: 'Entities/Chat/MessageBubble',
  component: MessageBubble,
  parameters: {
    chrome: true,
  },
  args: {
    record: record({ tag: 'Text', value: { text: 'hello <b>there</b>' } }),
    now: NOW,
    onAction: fn(),
    custom: customBody,
  },
} satisfies Meta<typeof MessageBubble>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a reader, I see a product message as text, and the exact time on hover. */
export const TextWithRelativeTime: Story = {
  play: async ({ canvas, step }) => {
    const row = canvas.getByTestId('chat-msg');
    const bubble = within(row).getByTestId('chat-msg-bubble');
    await step('Then the message is the product’s and its markup reads as text', async () => {
      await expect(row).toHaveAttribute('data-author', 'product');
      await expect(bubble.querySelector('b')).toBeNull();
      await expect(bubble).toHaveTextContent('hello <b>there</b>');
    });
    await step('Then it shows the exact time on hover', async () => {
      const time = within(bubble).getByTestId('chat-msg-time');
      await expect(time.title).not.toBe('');
    });
  },
};

/** As a reader, I see my own message marked as mine. */
export const OwnMessage: Story = {
  args: { record: record({ tag: 'Text', value: { text: 'me' } }, 'user') },
};

const RICH_KINDS = [
  { name: 'rich', content: { tag: 'RichText', value: { text: 'pics', media: [{}, {}] } } },
  { name: 'reaction', content: { tag: 'Reaction', value: { emoji: '👍' } } },
  { name: 'removed', content: { tag: 'ReactionRemoved', value: { emoji: '👍' } } },
  { name: 'file', content: { tag: 'File', value: { fileName: 'a.pdf' } } },
  { name: 'unknown', content: { tag: 'Hologram', value: {} } },
];

/** As a reader, I read rich text, reactions, files and unknown kinds each as their own line. */
export const RichKindsReadAsToday: Story = {
  render: args => (
    <For each={RICH_KINDS}>
      {kind => (
        <div data-testid={`kind-${kind.name}`}>
          <MessageBubble {...args} record={record(kind.content)} />
        </div>
      )}
    </For>
  ),
  play: async ({ canvas, step }) => {
    const bubbleOf = (name: string): HTMLElement =>
      within(canvas.getByTestId(`kind-${name}`)).getByTestId('chat-msg-bubble');
    await step('Then rich text shows its text and counts its attachments', async () => {
      await expect(bubbleOf('rich')).toHaveTextContent('pics');
      await expect(within(bubbleOf('rich')).getByTestId('chat-msg-meta').textContent).toBe(' [2 attachments]');
    });
    await step('Then reactions read as what was done', async () => {
      await expect(bubbleOf('reaction')).toHaveTextContent('reacted 👍');
      await expect(bubbleOf('removed')).toHaveTextContent('removed reaction 👍');
    });
    await step('Then a file shows its name', async () => {
      await expect(bubbleOf('file')).toHaveTextContent('[file] a.pdf');
    });
    await step('Then an unknown kind reads as unsupported', async () => {
      await expect(bubbleOf('unknown')).toHaveTextContent('[unsupported message]');
    });
  },
};

/** As a reader, I see an actions message's buttons in a grid. */
export const ActionButtons: Story = {
  args: {
    record: record({
      tag: 'Actions',
      value: {
        text: 'Choose',
        layout: 'Grid',
        actions: [
          { actionId: 'yes', title: 'Yes' },
          { actionId: 'no', title: 'No' },
        ],
      },
    }),
  },
};

/** As a reader, I see a custom message as the page's custom body beside its time. */
export const CustomBodyBeforeTimestamp: Story = {
  tags: ['!autodocs'],
  args: {
    record: record({ tag: 'Custom', value: { messageType: 'poll', payload: '0x01' } }),
  },
};
