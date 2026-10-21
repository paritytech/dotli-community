// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { Button, ButtonLink } from './Button.js';

const meta = {
  title: 'Primitives/Button',
  parameters: { chrome: true },
  component: Button,
  args: { children: 'Continue', onClick: fn() },
  argTypes: {
    variant: { control: 'inline-radio', options: ['secondary', 'primary', 'danger'] },
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a dotli user, I see the default secondary button and read its label. */
export const Secondary: Story = {};

/** As a dotli user, I press the primary button and its handler runs once. */
export const Primary: Story = {
  args: { variant: 'primary' },
  play: async ({ args, canvas, userEvent, step }) => {
    await step('When I press the button', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Continue' }));
    });
    await step('Then its handler runs once', async () => {
      await expect(args.onClick).toHaveBeenCalledOnce();
    });
  },
};

/** As a dotli user, I see a destructive choice drawn as a danger button and read what it denies. */
export const Danger: Story = { args: { variant: 'danger', children: 'Deny' } };

/** As a dotli user, I see the small, medium and large buttons side by side and tell them apart by size. */
export const Sizes: Story = {
  render: args => (
    <div style={{ display: 'flex', gap: '12px', 'align-items': 'center' }}>
      <Button {...args} size="sm">
        Small
      </Button>
      <Button {...args} size="md">
        Medium
      </Button>
      <Button {...args} size="lg">
        Large
      </Button>
    </div>
  ),
};

/** As a dotli user, I see a block button fill the width of its container and read its label. */
export const Block: Story = { args: { block: true, variant: 'primary' } };

// In a form, so a press that went through would also submit it.
/** As a dotli user, I press a disabled button and nothing happens, not even a form submit. */
export const Disabled: Story = {
  args: { disabled: true },
  render: args => {
    const [submitted, setSubmitted] = createSignal(false);
    return (
      <form
        data-testid="form"
        data-submitted={submitted() ? '' : undefined}
        onSubmit={ev => {
          ev.preventDefault();
          setSubmitted(true);
        }}
      >
        <Button {...args} />
      </form>
    );
  },
  play: async ({ args, canvas, userEvent, step }) => {
    const button = canvas.getByRole('button', { name: 'Continue' });
    await step('Given the button is disabled', async () => {
      await expect(button).toBeDisabled();
    });
    await step('When I press the disabled button', async () => {
      await userEvent.click(button);
    });
    await step('Then nothing happens and its form is not submitted', async () => {
      await expect(args.onClick).not.toHaveBeenCalled();
      await expect(button).toHaveAttribute('type', 'button');
      await expect(canvas.getByTestId('form')).not.toHaveAttribute('data-submitted');
    });
  },
};

/** Toggle `loading` off to watch the circle grow to the label. */
/** As a dotli user, I see a loading button busy with no label, and pressing it does nothing. */
export const Loading: Story = {
  args: { loading: true, 'aria-label': 'Continue' },
  play: async ({ args, canvas, userEvent, step }) => {
    const button = canvas.getByRole('button', { name: 'Continue' });
    await step('Then the button is busy and shows no label', async () => {
      await expect(button).toHaveAttribute('aria-busy', 'true');
      await expect(button).not.toHaveTextContent('Continue');
    });
    await step('When I press it, nothing happens', async () => {
      await userEvent.click(button);
      await expect(args.onClick).not.toHaveBeenCalled();
    });
  },
};

/** As a dotli user, I follow a link drawn as a button and it points where it says. */
export const Link: Story = {
  render: () => (
    <ButtonLink href="https://dot.li" variant="primary" size="lg" block>
      Open dot.li
    </ButtonLink>
  ),
  play: async ({ canvas, step }) => {
    await step('Then the link points where it says', async () => {
      const link = canvas.getByRole('link', { name: 'Open dot.li' });
      await expect(link).toHaveAttribute('href', 'https://dot.li');
    });
  },
};
