// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, within } from 'storybook/test';
import { onChatSurface } from '../../testing/stories/chatFrames.js';
import type { ChatMessageRecord } from './createChatStore.js';
import { MessageBubble } from './MessageBubble.js';

const NOW = 1_700_000_000_000;

const meta = {
  title: 'Entities/Chat/MessageBubble',
  component: MessageBubble,
  parameters: { chrome: true },
  args: {
    record: record({ tag: 'Text', value: { text: 'Your order #4821 is confirmed.' } }),
    onAction: fn(),
    custom: StandInBody,
  },
  decorators: [onChatSurface],
} satisfies Meta<typeof MessageBubble>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a reader, I see a product's message on the left, with its time inside the bubble. */
export const Default: Story = {};

/** As a reader, I see my own message on the right, light on the dark panel. */
export const Own: Story = {
  args: { record: { ...meta.args.record, author: 'user' } },
};

/** As a reader, I see a long unbroken word wrap inside the bubble. */
export const LongText: Story = {
  args: {
    record: record({
      tag: 'Text',
      value: { text: 'https://market.dot/orders/4821/receipt/route-from-kitchen-to-door-with-every-stop-on-the-way' },
    }),
  },
};

/** As a reader, I see rich text with a line that counts its attachments. */
export const RichTextAttachments: Story = {
  args: {
    record: record({ tag: 'RichText', value: { text: 'Here is the receipt and the route.', media: [{}, {}] } }),
  },
};

/** As a reader, I see a file by its name over its kind. */
export const File: Story = {
  args: { record: record({ tag: 'File', value: { fileName: 'receipt-4821.pdf' } }) },
};

/** As a reader, I see an actions message's buttons stacked in a column. */
export const ActionsColumn: Story = {
  args: { record: actions('Column', ['Great', 'Something was missing', 'Talk to support']) },
};

/** As a reader, I see an actions message's buttons in a grid. */
export const ActionsGrid = {
  args: { record: actions('Grid', ['Water', 'Lemonade', 'Cola', 'No, thanks']) },
} satisfies Story;

/** As a reader, I see a custom message as the page's custom body in a card, its time on a line below it. */
export const Custom = {
  args: { record: record({ tag: 'Custom', value: { messageType: 'delivery-time', payload: '0x01' } }) },
} satisfies Story;

/** As a reader, I see a reaction as a quiet event with its time, never a bubble. */
export const Reaction: Story = {
  args: { record: record({ tag: 'Reaction', value: { emoji: '👍' } }) },
};

/** As a reader, I see markup in a product's message as plain text. */
export const MarkupStaysText: Story = {
  args: { record: record({ tag: 'Text', value: { text: '<img src=x onerror=alert(1)>' } }) },
  play: async ({ canvas, mount, step }) => {
    await step('When a message that holds markup renders', async () => {
      await mount();
    });
    await step('Then the bubble holds no element the markup names', async () => {
      await expect(within(canvas.getByTestId('chat-msg-bubble')).queryByRole('img')).toBeNull();
    });
  },
};

/** The page's custom body, standing in for the product's live render. */
function StandInBody(): JSX.Element {
  return <div>The app's own content</div>;
}

function record(content: unknown): ChatMessageRecord {
  return {
    seq: 1,
    productId: 'market.dot',
    roomId: 'orders',
    messageId: 'm1',
    author: 'product',
    content,
    timestamp: NOW - 5 * 60_000,
  };
}

function actions(layout: 'Column' | 'Grid', titles: string[]): ChatMessageRecord {
  return record({
    tag: 'Actions',
    value: { text: 'How was your last order?', layout, actions: titles.map(title => ({ actionId: title, title })) },
  });
}
