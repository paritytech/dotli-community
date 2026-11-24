// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createJSXDecorator, type Meta, type StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { ChatSurface } from '../../testing/stories/chatFrames.js';
import contactIconStories from './ContactIcon.stories.js';
import { ContactRow } from './ContactRow.js';

const NOW = Date.UTC(2026, 10, 23, 12);
const MINUTE = 60_000;

// In a contact list on the chat panel's surface.
const inList = createJSXDecorator(Story => (
  <ChatSurface>
    <ul style={{ 'list-style': 'none', margin: '0', padding: '0' }}>
      <Story />
    </ul>
  </ChatSurface>
));

const meta = {
  title: 'Entities/Chat/ContactRow',
  component: ContactRow,
  parameters: { chrome: true },
  args: {
    ...contactIconStories.args,
    id: 'room-1',
    readOnly: false,
    lastMessageAt: NOW - 24 * 60 * MINUTE,
    now: NOW,
    unread: 0,
    onOpen: fn(),
  },
  decorators: [inList],
} satisfies Meta<typeof ContactRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see a room with nothing unread and when its last message came. */
export const Default: Story = {};

/** As a user, I see a room that has had no message yet, with no time. */
export const NoMessageYet: Story = {
  args: { lastMessageAt: null },
};

/** As a user, I see a room whose name is longer than the row cut short before its time. */
export const LongName: Story = {
  args: { name: 'Market orders for the whole neighbourhood, delivered by the evening courier' },
};

/** As a screen-reader user, I hear the unread badge's full count while it shows a capped one. */
export const Unread: Story = {
  args: { unread: 12, lastMessageAt: NOW - 2 * MINUTE },
  play: async ({ canvas, mount, step }) => {
    await step('When a room with more unread messages than the badge shows renders', async () => {
      await mount();
    });
    await step('Then the badge is an image named with the full count', async () => {
      await expect(canvas.getByRole('img', { name: /12/ })).toBeVisible();
    });
  },
};
