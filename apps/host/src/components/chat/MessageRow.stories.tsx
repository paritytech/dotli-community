// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, Show } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import type { ChatMessage } from '@dotli/ui-entities';
import { MessageRow } from './MessageRow.js';

const NOW = 1_700_000_000_000;

function record(content: unknown): ChatMessage {
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
      await expect(args.chat.triggerAction).toHaveBeenCalledWith('app.dot', 'main', {
        messageId: 'm1',
        actionId: 'yes',
      });
      await waitFor(() => expect(args.onActionError).toHaveBeenCalledTimes(1));
    });
  },
};

const stopCustom = fn();

export const CustomMessageBeforeTimestamp: Story = {
  tags: ['!autodocs'],
  args: {
    chat: { ...chat(), renderCustomMessage: fn(() => stopCustom) },
    record: record({ tag: 'Custom', value: { messageType: 'poll', payload: '0x01' } }),
  },
  // The row leaves the conversation when the reader removes it.
  render: args => {
    const [shown, setShown] = createSignal(true);
    return (
      <>
        <button type="button" onClick={() => setShown(false)}>
          Remove message
        </button>
        <Show when={shown()}>
          <MessageRow {...args} />
        </Show>
      </>
    );
  },
  play: async ({ args, canvas, userEvent, step }) => {
    await step('Then the live content comes before the timestamp and subscribes once', async () => {
      const bubble = canvas.getByTestId('chat-msg-bubble');
      await expect(bubble).toHaveAttribute('data-custom');
      await expect(bubble.firstElementChild).toHaveAttribute('data-testid', 'chat-custom-root');
      await expect(bubble.lastElementChild?.tagName).toBe('TIME');
      await waitFor(() => expect(args.chat.renderCustomMessage).toHaveBeenCalledTimes(1));
    });
    await step('When the message is removed', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Remove message' }));
    });
    await step('Then its live content stops', async () => {
      await waitFor(() => expect(stopCustom).toHaveBeenCalledTimes(1));
    });
  },
};
