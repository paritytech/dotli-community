// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { ChatSurface } from '../../testing/stories/chatFrames.js';
import { ContactRow } from './ContactRow.js';

const NOW = Date.UTC(2026, 10, 23, 12);
const MINUTE = 60_000;

const meta = {
  title: 'Entities/Chat/ContactRow',
  component: ContactRow,
  parameters: { chrome: true },
  args: {
    id: 'room-1',
    kind: 'room',
    name: 'Courier',
    icon: '',
    readOnly: false,
    lastMessageAt: NOW - 24 * 60 * MINUTE,
    now: NOW,
    unread: 0,
    onOpen: fn(),
  },
  render: args => (
    <ChatSurface>
      <ul style={{ 'list-style': 'none', margin: '0', padding: '0' }}>
        <ContactRow {...args} />
      </ul>
    </ChatSurface>
  ),
} satisfies Meta<typeof ContactRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see a room with nothing unread and when its last message came. */
export const Room: Story = {};

/** As a user, I see a room that has had no message yet, with no time. */
export const NoMessageYet: Story = {
  args: { lastMessageAt: null },
};

/** As a user, I see a contact that is a bot. */
export const Bot: Story = {
  args: { kind: 'bot', name: 'Support', lastMessageAt: NOW - 60 * MINUTE },
};

/** As a user, I see a room I can only read. */
export const ReadOnly: Story = {
  args: { name: 'Promotions', readOnly: true, lastMessageAt: NOW - 3 * 24 * 60 * MINUTE },
};

/** As a screen-reader user, I hear the unread badge's full count while it shows a capped one. */
export const UnreadBadge: Story = {
  args: { name: 'Market orders', unread: 12, lastMessageAt: NOW - 2 * MINUTE },
  play: async ({ canvas, step }) => {
    await step('Then the badge is an image named with the full count', async () => {
      await expect(canvas.getByRole('img', { name: '12 unread messages' })).toBeVisible();
    });
  },
};
