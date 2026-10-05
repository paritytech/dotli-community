// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { Button, ButtonLink } from './Button.js';

const meta = {
  title: 'Primitives/Button',
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

export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ args, canvas, userEvent, step }) => {
    await step('When I press the disabled button', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Continue' }));
    });
    await step('Then nothing happens', async () => {
      await expect(args.onClick).not.toHaveBeenCalled();
    });
  },
};

export const Link: Story = {
  render: () => (
    <ButtonLink href="https://dot.li" variant="primary">
      Open dot.li
    </ButtonLink>
  ),
};

export const Light: Story = {
  args: { variant: 'primary' },
  globals: { theme: 'light' },
  play: async ({ step }) => {
    await step('Then the page is in the light theme', async () => {
      await expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
  },
};

export const Theme: Story = {
  globals: { theme: 'dark' },
  play: async ({ step }) => {
    await step('Then a dark story leaves no light theme on the page', async () => {
      await expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    });
  },
};
