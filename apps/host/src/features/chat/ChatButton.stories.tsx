// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { createJSXDecorator, type Meta, type StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { TopbarFrame } from '../../testing/stories/topbarFrame.js';
import { ChatButton } from './ChatButton.js';
import { CHAT_PANEL_ID } from './chatPanelId.js';

type ButtonArgs = {
  visible: boolean;
  open: boolean;
  /** The count as the badge shows it, undefined for none. */
  unread: string | undefined;
  onToggle: () => void;
};

// In the bar, beside a stand-in for the panel the button controls.
const inTopbar = createJSXDecorator(Story => (
  <>
    <TopbarFrame>
      <Story />
    </TopbarFrame>
    <aside id={CHAT_PANEL_ID} aria-label="Product chat" />
  </>
));

const meta = {
  title: 'Host/Chat/ChatButton',
  component: PlainChatButton,
  parameters: { chrome: true },
  args: { visible: true, open: false, unread: undefined, onToggle: fn() },
  decorators: [inTopbar],
} satisfies Meta<typeof PlainChatButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see the chat button while the page has chat for me, with nothing unread. */
export const Default: Story = {};

/** As a screen-reader user, I hear how many chat messages wait for me while the panel is closed. */
export const Unread: Story = {
  args: { unread: '3' },
  play: async ({ canvas, mount, step }) => {
    await step('When the button renders with three unread', async () => {
      await mount();
    });
    // The badge is inside the named button, so the count reaches assistive technology only through the name.
    await step('Then the button is named with the count', async () => {
      await expect(canvas.getByRole('button', { name: /3/ })).toBeVisible();
    });
  },
};

/** As a screen-reader user, I find the chat button announced as expanded while the panel is open. */
export const Open: Story = {
  args: { open: true },
  play: async ({ canvas, mount, step }) => {
    await step('When the button renders with the panel open', async () => {
      await mount();
    });
    await step('Then the button is announced as expanded', async () => {
      await expect(canvas.getByRole('button', { expanded: true })).toBeVisible();
    });
  },
};

/** The button handed plain args, as the page hands it the chat state it follows. */
function PlainChatButton(props: ButtonArgs): JSX.Element {
  return (
    <ChatButton
      visible={() => props.visible}
      open={() => props.open}
      unread={() => props.unread}
      onToggle={() => {
        props.onToggle();
      }}
    />
  );
}
