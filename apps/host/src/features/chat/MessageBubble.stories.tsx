// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, within } from 'storybook/test';
import type { ChatMessageRecord } from './createChatStore.js';
import { MessageBubble } from './MessageBubble.js';

const NOW = 1_700_000_000_000;
const PHONE = { viewport: { value: 'phone', isRotated: false } };

type Author = ChatMessageRecord['author'];

function record(content: unknown, author: Author = 'product'): ChatMessageRecord {
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

function text(value: string): unknown {
  return { tag: 'Text', value: { text: value } };
}

function actions(prompt: string, layout: 'Column' | 'Grid', titles: string[]): unknown {
  return {
    tag: 'Actions',
    value: { text: prompt, layout, actions: titles.map(title => ({ actionId: title, title })) },
  };
}

/** The page's custom body, standing in for the product's live render. */
function customBody() {
  return <div data-testid="chat-custom-root">poll</div>;
}

/** A conversation's column of messages, as wide as the panel. */
function Thread(props: { children: JSX.Element }): JSX.Element {
  return (
    <div
      data-testid="thread"
      style={{ display: 'flex', 'flex-direction': 'column', gap: 'var(--sp-hair)', 'max-width': '380px' }}
    >
      {props.children}
    </div>
  );
}

/** A run of one author's messages, the last ending the run. */
function Run(props: { author: Author; contents: unknown[] }): JSX.Element {
  return (
    <For each={props.contents}>
      {(content, index) => (
        <MessageBubble
          record={record(content, props.author)}
          now={NOW}
          endsRun={index() === props.contents.length - 1}
          onAction={fn()}
          custom={customBody}
        />
      )}
    </For>
  );
}

const PRODUCT_RUN = [
  text('Your order #4821 is confirmed.'),
  text('The kitchen starts at 4:45 PM.'),
  text('When should we bring it?'),
];
const OWN_RUN = [
  text('Standard is great'),
  text('Please ring twice, the bell is quiet and the dog sleeps through knocking.'),
];

const meta = {
  title: 'Entities/Chat/MessageBubble',
  component: MessageBubble,
  parameters: {
    chrome: true,
  },
  args: {
    record: record(text('hello <b>there</b>')),
    now: NOW,
    endsRun: true,
    onAction: fn(),
    custom: customBody,
  },
  render: args => (
    <Thread>
      <MessageBubble {...args} />
    </Thread>
  ),
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
      const time = within(row).getByTestId('chat-msg-time');
      await expect(time.title).not.toBe('');
    });
  },
};

/** As a reader, I see no time on a message its author followed up within the minute. */
export const InsideARun: Story = {
  args: { endsRun: false },
  play: async ({ canvas, step }) => {
    await step('Then the bubble shows its text without a time', async () => {
      await expect(canvas.getByTestId('chat-msg-bubble')).toHaveTextContent('hello <b>there</b>');
      await expect(canvas.queryByTestId('chat-msg-time')).toBeNull();
    });
  },
};

/** As a reader, I see an app's run of messages close together, the last with its tail and time. */
export const ProductRun: Story = {
  render: () => (
    <Thread>
      <Run author="product" contents={PRODUCT_RUN} />
    </Thread>
  ),
};

/** As a reader, I see my own run of messages at the end, in my own tint. */
export const OwnRun: Story = {
  render: () => (
    <Thread>
      <Run author="user" contents={OWN_RUN} />
    </Thread>
  ),
};

/** As a reader, I see rich text with a line that counts its attachments. */
export const RichTextAttachments: Story = {
  args: {
    record: record({ tag: 'RichText', value: { text: 'Here is the receipt and the route.', media: [{}, {}] } }),
  },
  play: async ({ canvas, step }) => {
    await step('Then rich text shows its text and counts its attachments', async () => {
      await expect(canvas.getByTestId('chat-msg-bubble')).toHaveTextContent('Here is the receipt and the route.');
      await expect(canvas.getByTestId('chat-msg-meta').textContent).toBe('2 attachments');
    });
  },
};

/** As a reader, I see a file by its name over its kind. */
export const File: Story = {
  args: { record: record({ tag: 'File', value: { fileName: 'receipt-4821.pdf' } }) },
  play: async ({ canvas, step }) => {
    await step('Then a file shows its name over its kind', async () => {
      await expect(canvas.getByTestId('chat-msg-bubble')).toHaveTextContent('receipt-4821.pdf');
      await expect(canvas.getByTestId('chat-msg-meta').textContent).toBe('File');
    });
  },
};

/** As a reader, I see an actions message's buttons stacked in a column. */
export const ActionsColumn: Story = {
  args: {
    record: record(
      actions('How was your last order?', 'Column', ['Great', 'Something was missing', 'Talk to support']),
    ),
  },
};

/** As a reader, I see an actions message's buttons in a grid. */
export const ActionsGrid: Story = {
  args: { record: record(actions('Add a drink?', 'Grid', ['Water', 'Lemonade', 'Cola', 'No, thanks'])) },
};

const EVENTS = [
  { name: 'reaction', content: { tag: 'Reaction', value: { emoji: '👍' } } },
  { name: 'removed', content: { tag: 'ReactionRemoved', value: { emoji: '👍' } } },
  { name: 'unknown', content: { tag: 'Hologram', value: {} } },
];

/** As a reader, I see reactions and kinds the page does not know as quiet events, each with its time. */
export const Events: Story = {
  render: args => (
    <Thread>
      <For each={EVENTS}>
        {kind => (
          <div data-testid={`kind-${kind.name}`}>
            <MessageBubble {...args} record={record(kind.content)} endsRun={false} />
          </div>
        )}
      </For>
    </Thread>
  ),
  play: async ({ canvas, step }) => {
    const eventOf = (name: string): HTMLElement =>
      within(canvas.getByTestId(`kind-${name}`)).getByTestId('chat-msg-bubble');
    await step('Then reactions read as what was done', async () => {
      await expect(eventOf('reaction')).toHaveTextContent('Reacted 👍');
      await expect(eventOf('removed')).toHaveTextContent('Removed reaction 👍');
    });
    await step('Then an unknown kind reads as unsupported', async () => {
      await expect(eventOf('unknown')).toHaveTextContent('Unsupported message');
    });
    await step('Then each event shows its time, though none ends a run', async () => {
      for (const { name } of EVENTS) {
        await expect(within(eventOf(name)).getByTestId('chat-msg-time')).toBeInTheDocument();
      }
    });
  },
};

/** As a reader, I see a custom message as the page's custom body in a card, before its time. */
export const CustomBodyBeforeTimestamp: Story = {
  tags: ['!autodocs'],
  args: {
    record: record({ tag: 'Custom', value: { messageType: 'poll', payload: '0x01' } }),
  },
};

/** As a phone user, I read a conversation at the phone's size. */
export const Phone: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
  render: () => (
    <Thread>
      <Run author="product" contents={[text('Your order #4821 is confirmed.'), text('When should we bring it?')]} />
      <Run author="product" contents={[actions('Add a drink?', 'Grid', ['Water', 'Lemonade'])]} />
      <Run author="user" contents={OWN_RUN} />
    </Thread>
  ),
};
