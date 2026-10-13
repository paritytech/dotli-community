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

export const Secondary: Story = {};

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

export const Danger: Story = { args: { variant: 'danger', children: 'Deny' } };

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

export const Block: Story = { args: { block: true, variant: 'primary' } };

// In a form, so a press that went through would also submit it.
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

export const WithPopup: Story = {
  args: {
    children: 'alice',
    'aria-label': 'alice, account',
    'aria-expanded': 'true',
    'aria-controls': 'story-user-popover',
    'aria-haspopup': 'dialog',
  },
  render: args => (
    <>
      <Button {...args} />
      <div id="story-user-popover">Account details</div>
    </>
  ),
  play: async ({ canvas, step }) => {
    await step('Then I hear the label and the open popup the button controls', async () => {
      const button = canvas.getByRole('button', { name: 'alice, account' });
      await expect(button).toHaveAttribute('aria-expanded', 'true');
      await expect(button).toHaveAttribute('aria-controls', 'story-user-popover');
      await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    });
  },
};

/** Toggle `loading` off to watch the circle grow to the label. */
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

export const Link: Story = {
  render: () => (
    <ButtonLink href="https://dot.li" variant="primary" size="lg" block>
      Open dot.li
    </ButtonLink>
  ),
  play: async ({ canvas, step }) => {
    await step('Then the link drawn as a large primary button points where it says', async () => {
      const link = canvas.getByRole('link', { name: 'Open dot.li' });
      await expect(link).toHaveAttribute('href', 'https://dot.li');
      await expect(link).toHaveAttribute('data-variant', 'primary');
      await expect(link).toHaveAttribute('data-size', 'lg');
      await expect(link).toHaveAttribute('data-block', '');
    });
  },
};
