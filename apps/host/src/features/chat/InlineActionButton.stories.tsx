// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { InlineActionButton, type InlineActionButtonVariant } from './InlineActionButton.js';

const PHONE = { viewport: { value: 'phone', isRotated: false } };

const VARIANTS: { variant: InlineActionButtonVariant; label: string }[] = [
  { variant: 'primary', label: 'Confirm' },
  { variant: 'secondary', label: 'Later' },
  { variant: 'text', label: 'Details' },
];

/** Each variant at rest, disabled and loading, one row per variant. */
function States(): JSX.Element {
  return (
    <div
      style={{
        display: 'grid',
        'grid-template-columns': 'repeat(3, minmax(0, 160px))',
        gap: 'var(--sp-3)',
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
  );
}

const meta = {
  title: 'Entities/Chat/InlineActionButton',
  component: InlineActionButton,
  parameters: { chrome: true },
  args: { variant: 'primary', onClick: fn(), children: 'Confirm' },
  argTypes: { variant: { control: 'inline-radio', options: ['primary', 'secondary', 'text'] } },
  render: args => (
    <div style={{ 'max-width': '200px' }}>
      <InlineActionButton {...args} />
    </div>
  ),
} satisfies Meta<typeof InlineActionButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see each inline action button variant at rest, disabled and loading. */
export const VariantsAndStates: Story = {
  render: () => <States />,
};

/** As a phone user, I see the inline action buttons at the phone's touch size. */
export const Phone: Story = {
  tags: ['!autodocs'],
  globals: PHONE,
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
