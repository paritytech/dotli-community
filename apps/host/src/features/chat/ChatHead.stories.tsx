// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createJSXDecorator, type Meta, type StoryObj } from 'storybook-solidjs-vite';
import { fn } from 'storybook/test';
import { Drawer } from '@dotli/ui';
import contactIconStories from './ContactIcon.stories.js';
import { ChatHead } from './ChatHead.js';
import type { ContactEntry } from './contacts.js';

const COURIER: ContactEntry = {
  ...contactIconStories.args,
  id: 'courier',
  createdAt: 0,
  lastMessageAt: null,
  footer: 'TextInput',
};

// As the title of the drawer the page opens the chat in, over the chat panel's surface.
const inDrawerHead = createJSXDecorator(Story => (
  <Drawer open onOpenChange={() => undefined} title={<Story />} testId="chat-panel">
    <div style={{ height: '100%', background: 'var(--chat-bg-panel)' }} />
  </Drawer>
));

const meta = {
  title: 'Host/Chat/ChatHead',
  component: ChatHead,
  parameters: { chrome: true },
  // The drawer covers the page it opens on, so it has no docs block.
  tags: ['!autodocs'],
  args: { shown: { contact: COURIER, sole: false }, onBack: fn() },
  decorators: [inDrawerHead],
} satisfies Meta<typeof ChatHead>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user of a product with several rooms, I see the open room's avatar and name after a way back to the list. */
export const Default: Story = {};

/** As a user of a product with one room, I see its avatar and name with no way back, as no list stands behind it. */
export const SoleRoom: Story = {
  args: { shown: { contact: COURIER, sole: true } },
};

/** As a user, I see a room whose name is longer than the head cut short on one line. */
export const LongName: Story = {
  args: {
    shown: {
      contact: { ...COURIER, name: 'Market orders for the whole neighbourhood, delivered by the evening courier' },
      sole: false,
    },
  },
};
