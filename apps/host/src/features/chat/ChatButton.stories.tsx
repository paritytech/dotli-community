// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect } from 'storybook/test';
import { byId } from '@dotli/ui/testing';
import { TopbarFrame } from '../../testing/stories/topbarFrame.js';
import { type ChatStage, chatStage } from '../../testing/stories/chatFixtures.js';
import { ChatButton } from './ChatButton.js';
import { CHAT_PANEL_ID } from './chatPanelId.js';

/** The story's chat, fresh for each. */
let stage: ChatStage = chatStage();

const meta = {
  title: 'Host/Chat/ChatButton',
  component: ChatButton,
  parameters: { chrome: true },
  args: stage.button,
  beforeEach: () => {
    stage = chatStage();
    return stage.dispose;
  },
  render: () => (
    <TopbarFrame>
      <ChatButton {...stage.button} />
    </TopbarFrame>
  ),
} satisfies Meta<typeof ChatButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see the chat button while the page has chat for me, with nothing unread. */
export const Idle: Story = {
  play: async ({ step }) => {
    await step('Then the button shows without a count', async () => {
      await expect(byId('chat-button')).toBeVisible();
      await expect(byId('chat-button')).toHaveAccessibleName('Chat');
      await expect(byId('chat-unread-badge')).not.toBeVisible();
    });
  },
};

/** As a user, I see how many chat messages wait for me while the panel is closed. */
export const Unread: Story = {
  beforeEach: () => {
    stage.update({ unread: 3 });
  },
  play: async ({ step }) => {
    await step('Then the badge shows the count and the button names it', async () => {
      await expect(byId('chat-unread-badge')).toBeVisible();
      await expect(byId('chat-unread-badge')).toHaveTextContent('3');
      await expect(byId('chat-button')).toHaveAccessibleName('Chat, 3 unread');
    });
  },
};

/** As a user, I see the chat button pressed while the panel is open. */
export const Open: Story = {
  beforeEach: () => {
    stage.update({ open: true });
  },
  // A stand-in for the panel the button controls.
  render: () => (
    <>
      <TopbarFrame>
        <ChatButton {...stage.button} />
      </TopbarFrame>
      <aside id={CHAT_PANEL_ID} aria-label="Product chat" />
    </>
  ),
  play: async ({ step }) => {
    await step('Then the button reads as expanded', async () => {
      await expect(byId('chat-button')).toHaveAttribute('aria-expanded', 'true');
    });
  },
};

/** As a user, I see the chat button only while the page has chat for me. */
export const HiddenWithoutChat: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    stage.update({ available: false });
  },
  play: async ({ step }) => {
    await step('Then the button is not on show', async () => {
      await expect(byId('chat-button')).not.toBeVisible();
    });
  },
};
