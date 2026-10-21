// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor } from 'storybook/test';
import { byId } from '@dotli/ui/testing';
import { TopbarFrame } from '../../testing/stories/topbar-frame.js';
import { type ChatStage, chatStage } from '../../testing/stories/chat-fixtures.js';
import { ChatButton } from './ChatButton.js';

/** The story's chat, fresh for each. */
let stage: ChatStage = chatStage();

const meta = {
  title: 'Host/Chat/ChatButton',
  component: ChatButton,
  parameters: { chrome: true },
  args: stage.button,
  beforeEach: () => {
    stage = chatStage({ available: false });
  },
  render: () => (
    <TopbarFrame>
      <ChatButton {...stage.button} />
    </TopbarFrame>
  ),
} satisfies Meta<typeof ChatButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see the chat button only while the page has chat for me. */
export const HiddenWithoutChat: Story = {
  tags: ['!autodocs'],
  play: async ({ step }) => {
    await step('As a user, the chat button shows only while the page has chat for me', async () => {
      // Then, before the page has chat
      await expect(byId('chat-button')).not.toBeVisible();

      // When chat becomes available
      stage.update({ available: true });

      // Then
      await waitFor(() => expect(byId('chat-button')).toBeVisible());

      // When it goes away, as when the product fails
      stage.update({ available: false });

      // Then
      await waitFor(() => expect(byId('chat-button')).not.toBeVisible());
    });
  },
};
