// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { onChatSurface } from '../../testing/stories/chatFrames.js';
import customMessageStories from './CustomMessage.stories.js';
import { ActionsGrid, Custom } from './MessageBubble.stories.js';
import { MessageRow } from './MessageRow.js';

const ACTIONS = ActionsGrid.args.record;

const chat = { ...customMessageStories.args.chat, triggerAction: fn(() => Promise.resolve()) };

const meta = {
  title: 'Host/Chat/MessageRow',
  component: MessageRow,
  parameters: { chrome: true },
  args: {
    chat,
    record: Custom.args.record,
    onActionError: fn(),
  },
  decorators: [onChatSurface],
} satisfies Meta<typeof MessageRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a reader, I see a custom message the product renders live in its card, above its time. */
export const Default: Story = {};

/** As a user, I press an action message's button and the tap reaches the app with the message it came from. */
export const ActionTapReachesApp: Story = {
  args: { record: ACTIONS },
  play: async ({ canvas, userEvent, step }) => {
    await step('When I press Water', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Water' }));
    });
    await step('Then the app gets the action with the message it came from', async () => {
      await expect(chat.triggerAction).toHaveBeenCalledWith({
        productId: ACTIONS.productId,
        roomId: ACTIONS.roomId,
        trigger: { messageId: ACTIONS.messageId, actionId: 'Water' },
      });
    });
  },
};

/** As a user, I press an action message's button when the app cannot be reached and the failure is reported once. */
export const UnreachableActionIsReported: Story = {
  args: {
    record: ACTIONS,
    chat: { ...chat, triggerAction: fn(() => Promise.reject(new Error('offline'))) },
  },
  play: async ({ args, canvas, userEvent, step }) => {
    await step('When I press Water and the app cannot be reached', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Water' }));
    });
    await step('Then the failure is reported once', async () => {
      await waitFor(() => expect(args.onActionError).toHaveBeenCalledTimes(1));
    });
  },
};
