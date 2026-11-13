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

/** As a user, I see a contact with nothing unread. */
export const Contact: Story = {};

/** As a screen-reader user, I hear the unread badge's full count while it shows a capped one. */
export const UnreadBadge: Story = {
  args: { unread: 12 },
  play: async ({ canvas, step }) => {
    await step('Then the badge is an image named with the full count', async () => {
      await expect(canvas.getByRole('img', { name: '12 unread messages' })).toBeVisible();
    });
  },
};
