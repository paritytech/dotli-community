// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { ContactRow } from './ContactRow.js';

const meta = {
  title: 'Entities/Chat/ContactRow',
  component: ContactRow,
  parameters: { chrome: true },
  args: { id: 'room-1', name: 'Support', icon: '', unread: 0, onOpen: fn() },
  render: args => (
    <ul style={{ 'list-style': 'none', margin: '0', padding: '0', width: '280px' }}>
      <ContactRow {...args} />
    </ul>
  ),
} satisfies Meta<typeof ContactRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I choose a contact and the list learns which one by its id. */
export const OpensById: Story = {
  play: async ({ args, canvas, userEvent, step }) => {
    await step('Given a contact with no unread messages', async () => {
      await expect(canvas.getByTestId('chat-room-name')).toHaveTextContent('Support');
      await expect(canvas.queryByTestId('chat-room-unread')).toBeNull();
    });
    await step('When I choose it', async () => {
      await userEvent.click(canvas.getByTestId('chat-room-item'));
    });
    await step('Then it reports its id', async () => {
      await expect(args.onOpen).toHaveBeenCalledWith('room-1');
    });
  },
};

/** As a screen-reader user, the unread badge reads its full count while showing a capped one. */
export const UnreadBadge: Story = {
  args: { unread: 12 },
  play: async ({ canvas, step }) => {
    await step('Then the badge shows 9+ and is named with the full count', async () => {
      const badge = canvas.getByTestId('chat-room-unread');
      await expect(badge).toHaveTextContent('9+');
      await expect(badge).toHaveAttribute('aria-label', '12 unread messages');
    });
  },
};
