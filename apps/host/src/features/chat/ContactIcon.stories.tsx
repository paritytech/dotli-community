// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor } from 'storybook/test';
import { onChatSurface } from '../../testing/stories/chatFrames.js';
import { ContactIcon } from './ContactIcon.js';

// Resolves nowhere, so the browser fails to load it.
const BROKEN = 'https://example.invalid/x.png';
const GOOD =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"%3E%3Crect width="1" height="1" fill="teal"/%3E%3C/svg%3E';

/** The icon the product sends for the room, which a play replaces. */
const [sentIcon, setSentIcon] = createSignal(BROKEN);

const meta = {
  title: 'Entities/Chat/ContactIcon',
  component: ContactIcon,
  parameters: { chrome: true },
  args: { name: 'Courier', icon: GOOD },
  decorators: [onChatSurface],
} satisfies Meta<typeof ContactIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see a contact with an icon as its image. */
export const Default: Story = {};

/** As a user, I see the initial of a contact that has no icon. */
export const NoIcon: Story = {
  args: { icon: '' },
};

/** As a user, I see the initial of a contact whose icon fails to load. */
export const BrokenIcon: Story = {
  args: { icon: BROKEN },
  play: async ({ canvas, step }) => {
    await step('Then the icon falls back to the initial', async () => {
      await waitFor(() => expect(canvas.getByTestId('chat-room-icon')).toHaveAttribute('data-fallback'));
    });
  },
};

/** As a user, I see a contact's new icon once the product sends one after the first failed to load. */
export const ReplacedBrokenIcon: Story = {
  beforeEach: () => {
    setSentIcon(BROKEN);
  },
  render: args => <ContactIcon {...args} icon={sentIcon()} />,
  play: async ({ canvas, step }) => {
    await step('Given the first icon failed to load', async () => {
      await waitFor(() => expect(canvas.getByTestId('chat-room-icon')).toHaveAttribute('data-fallback'));
    });
    await step('When the product sends a new icon for the room', () => {
      setSentIcon(GOOD);
    });
    await step('Then the new icon shows', async () => {
      await waitFor(() => expect(canvas.getByTestId('chat-room-icon')).not.toHaveAttribute('data-fallback'));
    });
  },
};
