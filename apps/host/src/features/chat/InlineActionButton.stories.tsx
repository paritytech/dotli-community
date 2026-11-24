// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { onChatSurface } from '../../testing/stories/chatFrames.js';
import { InlineActionButton } from './InlineActionButton.js';

const meta = {
  title: 'Entities/Chat/InlineActionButton',
  component: InlineActionButton,
  parameters: { chrome: true },
  args: { variant: 'primary', onClick: fn(), children: 'Confirm' },
  argTypes: { variant: { control: 'inline-radio', options: ['primary', 'secondary', 'text'] } },
  decorators: [onChatSurface],
} satisfies Meta<typeof InlineActionButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see the primary action of a message filled in the primary colour. */
export const Default: Story = {};

/** As a user, I see a secondary action on the nested surface, ringed. */
export const Secondary: Story = {
  args: { variant: 'secondary' },
};

/** As a user, I see a text action underlined, with no fill. */
export const Text: Story = {
  args: { variant: 'text' },
};

/** As a user, I see an action I cannot take as a faint outline. */
export const Disabled: Story = {
  args: { disabled: true },
};

/** As a user, I see a spinner over the label while the app works on the action. */
export const Loading: Story = {
  args: { loading: true },
};

/** As a keyboard user, I tab to an inline action button, press it with Enter, and the press is reported once. */
export const KeyboardPress: Story = {
  play: async ({ args, canvas, userEvent, step }) => {
    await step('When I tab to the button and press Enter', async () => {
      await userEvent.tab();
      await userEvent.keyboard('{Enter}');
    });
    await step('Then the button has focus and the press is reported once', async () => {
      await expect(canvas.getByRole('button', { name: 'Confirm' })).toHaveFocus();
      await expect(args.onClick).toHaveBeenCalledTimes(1);
    });
  },
};
