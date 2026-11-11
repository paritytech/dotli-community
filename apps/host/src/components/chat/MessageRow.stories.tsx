// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import type { ChatMessageRecord } from '../../runtime/chat/createChatStore.js';
import { MessageRow } from './MessageRow.js';

const NOW = 1_700_000_000_000;

function record(content: unknown): ChatMessageRecord {
  return {
    seq: 1,
    productId: 'app.dot',
    roomId: 'main',
    messageId: 'm1',
    author: 'product',
    content,
    timestamp: NOW - 5 * 60_000,
  };
}

/** The chat intents a row calls. */
function chat() {
  return {
    triggerAction: fn(() => Promise.resolve()),
    renderCustomMessage: fn(() => () => undefined),
    triggerRendererAction: fn(() => Promise.resolve()),
  };
}

const meta = {
  title: 'Host/Chat/MessageRow',
  component: MessageRow,
  parameters: {
    chrome: true,
  },
  args: {
    chat: chat(),
    record: record({ tag: 'Text', value: { text: 'hello' } }),
    now: NOW,
    onActionError: fn(),
  },
} satisfies Meta<typeof MessageRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I press an action button and it reaches the app, or I am told it could not. */
export const ActionButtonsReachApp: Story = {
  args: {
    chat: {
      ...chat(),
      triggerAction: fn(() => Promise.reject(new Error('offline'))),
    },
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
    await step('When I press Yes and the app cannot be reached', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Yes' }));
    });
    await step('Then the action reached the app and the failure is reported', async () => {
      await expect(args.chat.triggerAction).toHaveBeenCalledWith({
        productId: 'app.dot',
        roomId: 'main',
        trigger: { messageId: 'm1', actionId: 'yes' },
      });
      await waitFor(() => expect(args.onActionError).toHaveBeenCalledTimes(1));
    });
  },
};

/** As a reader, I see a custom message the product renders, before its time. */
export const CustomMessageBeforeTimestamp: Story = {
  tags: ['!autodocs'],
  args: {
    record: record({ tag: 'Custom', value: { messageType: 'poll', payload: '0x01' } }),
  },
};
