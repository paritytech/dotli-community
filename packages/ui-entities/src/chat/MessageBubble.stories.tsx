// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, within } from 'storybook/test';
import type { ChatMessage } from './message.js';
import { MessageBubble } from './MessageBubble.js';

const NOW = 1_700_000_000_000;

function record(content: unknown, author: 'product' | 'user' = 'product'): ChatMessage {
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
const customBody = fn(() => <div data-testid="chat-custom-root">poll</div>);

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

export const TextWithRelativeTime: Story = {
  play: async ({ canvas, step }) => {
    const row = canvas.getByTestId('chat-msg');
    const bubble = within(row).getByTestId('chat-msg-bubble');
    await step('Then the message is the product’s and its markup reads as text', async () => {
      await expect(row).toHaveAttribute('data-author', 'product');
      await expect(bubble.querySelector('b')).toBeNull();
      await expect(bubble).toHaveTextContent('hello <b>there</b>');
    });
    await step('Then it shows a relative time with the exact time on hover', async () => {
      const time = within(bubble).getByTestId('chat-msg-time');
      await expect(time.tagName).toBe('TIME');
      await expect(time).toHaveTextContent('5 mins ago');
      await expect(time).toHaveAttribute('data-timestamp', String(NOW - 5 * 60_000));
      await expect(time.title).not.toBe('');
    });
  },
};

export const OwnMessage: Story = {
  args: { record: record({ tag: 'Text', value: { text: 'me' } }, 'user') },
  play: async ({ canvas, step }) => {
    await step('Then my own message is marked as mine', async () => {
      await expect(canvas.getByTestId('chat-msg')).toHaveAttribute('data-author', 'user');
    });
  },
};

const RICH_KINDS = [
  { name: 'rich', content: { tag: 'RichText', value: { text: 'pics', media: [{}, {}] } } },
  { name: 'reaction', content: { tag: 'Reaction', value: { emoji: '👍' } } },
  { name: 'removed', content: { tag: 'ReactionRemoved', value: { emoji: '👍' } } },
  { name: 'file', content: { tag: 'File', value: { fileName: 'a.pdf' } } },
  { name: 'unknown', content: { tag: 'Hologram', value: {} } },
];

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
    await step('Then reactions read as events', async () => {
      await expect(bubbleOf('reaction')).toHaveAttribute('data-event');
      await expect(bubbleOf('reaction')).toHaveTextContent('reacted 👍');
      await expect(bubbleOf('removed')).toHaveTextContent('removed reaction 👍');
    });
    await step('Then a file shows its name', async () => {
      await expect(bubbleOf('file')).toHaveTextContent('[file] a.pdf');
    });
    await step('Then an unknown kind reads as an unsupported event', async () => {
      await expect(bubbleOf('unknown')).toHaveAttribute('data-event');
      await expect(bubbleOf('unknown')).toHaveTextContent('[unsupported message]');
    });
  },
};

export const ActionButtonsReportTaps: Story = {
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
  play: async ({ args, canvas, userEvent, step }) => {
    await step('Given the actions lay out as a grid of secondary buttons', async () => {
      await expect(canvas.getByTestId('chat-msg-actions')).toHaveAttribute('data-layout', 'grid');
      const buttons = within(canvas.getByTestId('chat-msg-actions')).getAllByRole('button');
      await expect(buttons.map(b => [b.textContent, b.dataset['variant']])).toEqual([
        ['Yes', 'secondary'],
        ['No', 'secondary'],
      ]);
    });
    await step('When I press Yes', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Yes' }));
    });
    await step('Then the page hears which action I chose', async () => {
      await expect(args.onAction).toHaveBeenCalledWith('yes');
    });
  },
};

export const CustomBodyBeforeTimestamp: Story = {
  tags: ['!autodocs'],
  args: {
    record: record({ tag: 'Custom', value: { messageType: 'poll', payload: '0x01' } }),
  },
  play: async ({ args, canvas, step }) => {
    await step('Then the page renders the custom body once, and it comes before the timestamp', async () => {
      const bubble = canvas.getByTestId('chat-msg-bubble');
      await expect(bubble).toHaveAttribute('data-custom');
      await expect(bubble.firstElementChild).toHaveAttribute('data-testid', 'chat-custom-root');
      await expect(bubble.lastElementChild?.tagName).toBe('TIME');
      await expect(args.custom).toHaveBeenCalledTimes(1);
      await expect(args.custom).toHaveBeenCalledWith({ messageType: 'poll', payload: '0x01' });
    });
  },
};
