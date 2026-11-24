// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { ChatSurface } from '../../testing/stories/chatFrames.js';
import { InlineActionButton, type InlineActionButtonVariant } from './InlineActionButton.js';

const VARIANTS: { variant: InlineActionButtonVariant; label: string }[] = [
  { variant: 'primary', label: 'Confirm' },
  { variant: 'secondary', label: 'Later' },
  { variant: 'text', label: 'Details' },
];

/** Each variant at rest, disabled and loading, one row per variant, on the chat panel's surface. */
function States(): JSX.Element {
  return (
    <ChatSurface>
      <div
        style={{
          display: 'grid',
          'grid-template-columns': 'repeat(3, minmax(0, 1fr))',
          gap: 'var(--sp-2)',
          'align-items': 'center',
        }}
      >
        <For each={VARIANTS}>
          {({ variant, label }) => (
            <>
              <InlineActionButton variant={variant} onClick={fn()}>
                {label}
              </InlineActionButton>
              <InlineActionButton variant={variant} disabled onClick={fn()}>
                {label}
              </InlineActionButton>
              <InlineActionButton variant={variant} loading onClick={fn()}>
                {label}
              </InlineActionButton>
            </>
          )}
        </For>
      </div>
    </ChatSurface>
  );
}

const meta = {
  title: 'Entities/Chat/InlineActionButton',
  component: InlineActionButton,
  parameters: { chrome: true },
  args: { variant: 'primary', onClick: fn(), children: 'Confirm' },
  argTypes: { variant: { control: 'inline-radio', options: ['primary', 'secondary', 'text'] } },
  render: args => (
    <ChatSurface>
      <InlineActionButton {...args} />
    </ChatSurface>
  ),
} satisfies Meta<typeof InlineActionButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see each inline action button variant at rest, disabled and loading. */
export const VariantsAndStates: Story = {
  render: () => <States />,
};

/** As a keyboard user, I tab to an inline action button and press it with Enter. */
export const Focus: Story = {
  play: async ({ args, canvas, userEvent, step }) => {
    await step('When I tab to the button and press Enter', async () => {
      await userEvent.tab();
      await userEvent.keyboard('{Enter}');
    });
    await step('Then the button has focus and the press is reported', async () => {
      await expect(canvas.getByRole('button', { name: 'Confirm' })).toHaveFocus();
      await expect(args.onClick).toHaveBeenCalledTimes(1);
    });
  },
};
