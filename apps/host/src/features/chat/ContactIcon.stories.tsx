// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor } from 'storybook/test';
import { ChatSurface } from '../../testing/stories/chatFrames.js';
import { ContactIcon } from './ContactIcon.js';

// Resolves nowhere, so the browser fails to load it.
const BROKEN = 'https://example.invalid/x.png';
const GOOD =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"%3E%3Crect width="1" height="1" fill="teal"/%3E%3C/svg%3E';

/** The icon the product sends for the room, which a play replaces. */
const [sentIcon, setSentIcon] = createSignal(BROKEN);

/** Icons side by side on the chat panel's surface. */
function Icons(props: { children: JSX.Element }): JSX.Element {
  return (
    <ChatSurface>
      <div style={{ display: 'flex', 'align-items': 'center', gap: 'var(--sp-3)' }}>{props.children}</div>
    </ChatSurface>
  );
}

const meta = {
  title: 'Entities/Chat/ContactIcon',
  component: ContactIcon,
  parameters: { chrome: true },
  args: { name: 'Support', icon: GOOD },
  render: args => (
    <Icons>
      <ContactIcon {...args} />
    </Icons>
  ),
} satisfies Meta<typeof ContactIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see a contact with an icon as its image. */
export const WithIcon: Story = {};

/** As a user, I see the smaller icons a conversation's head shows beside the room's name, an initial and an image. */
export const Small: Story = {
  render: () => (
    <Icons>
      <ContactIcon name="Courier" icon="" size="sm" />
      <ContactIcon name="Team" icon={GOOD} size="sm" />
    </Icons>
  ),
};

/** As a user, I see the initial of a contact with no icon or a broken one, and the image of one with an icon. */
export const InitialWithoutIcon: Story = {
  render: () => (
    <Icons>
      <ContactIcon name="general" icon="" />
      <ContactIcon name="Team" icon={GOOD} />
      <ContactIcon name="Support" icon={BROKEN} />
    </Icons>
  ),
  play: async ({ canvasElement, step }) => {
    const icons = (): HTMLElement[] => [
      ...canvasElement.querySelectorAll<HTMLElement>('[data-testid="chat-room-icon"]'),
    ];
    await step('Then a contact with no icon shows its initial, hidden from assistive tech', async () => {
      const fallback = icons().find(el => el.hasAttribute('data-fallback'));
      await expect(fallback).toHaveTextContent('G');
      await expect(fallback).toHaveAttribute('aria-hidden', 'true');
    });
    await step('Then a contact with an icon shows it as a decorative image', async () => {
      const img = icons().find(el => el.getAttribute('src') === GOOD);
      await expect(img).not.toHaveAttribute('data-fallback');
      await expect(img?.getAttribute('alt')).toBe('');
    });
    await step('Then an icon that fails to load falls back to the initial', async () => {
      await waitFor(() => expect(icons().filter(el => el.hasAttribute('data-fallback'))).toHaveLength(2));
      await expect(icons().find(el => el.textContent === 'S')).toHaveAttribute('data-fallback');
    });
  },
};

/** As a user, I see a contact's new icon once the product sends one after the first failed to load. */
export const ReplacedBrokenIcon: Story = {
  beforeEach: () => {
    setSentIcon(BROKEN);
  },
  render: () => (
    <Icons>
      <ContactIcon name="Support" icon={sentIcon()} />
    </Icons>
  ),
  play: async ({ canvas, canvasElement, step }) => {
    await step('Given the first icon failed to load', async () => {
      await waitFor(() => expect(canvasElement.querySelector('img')).toBeNull());
      await expect(canvas.getByTestId('chat-room-icon')).toHaveAttribute('data-fallback');
    });
    await step('When the product sends a new icon for the room', () => {
      setSentIcon(GOOD);
    });
    await step('Then the new icon shows', async () => {
      await waitFor(() => expect(canvas.getByTestId('chat-room-icon')).toHaveAttribute('src', GOOD));
      await expect(canvas.getByTestId('chat-room-icon')).not.toHaveAttribute('data-fallback');
    });
  },
};
