// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, untrack } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { Switch } from './Switch.js';

const meta = {
  title: 'Primitives/Switch',
  parameters: { chrome: true },
  component: Switch,
  args: { checked: false, label: 'Notifications', onChange: fn() },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a screen reader user, I hear a named switch that is off. */
export const Off: Story = {
  play: async ({ canvas, step }) => {
    await step('Then I hear a named switch that is off', async () => {
      const toggle = canvas.getByRole('switch', { name: 'Notifications' });
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(toggle).toHaveAttribute('type', 'button');
    });
  },
};

// No owner updates `checked` here.
/** As a dotli user, I flip a switch and its owner hears the next value while the switch does not flip itself. */
export const OwnerDecides: Story = {
  play: async ({ args, canvas, userEvent, step }) => {
    const toggle = canvas.getByRole('switch', { name: 'Notifications' });
    await step('When I flip the switch', async () => {
      await userEvent.click(toggle);
    });
    await step('Then its owner hears the next value and the switch does not flip itself', async () => {
      await expect(args.onChange).toHaveBeenCalledOnce();
      await expect(args.onChange).toHaveBeenCalledWith(true);
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
    });
  },
};
/** As a dotli user, I see a switch that is on. */
export const On: Story = { args: { checked: true } };

// The switch shows `checked` until its owner updates it, so this owner does.
/** As a dotli user, I press a switch and it turns on and reports it. */
export const Interactive: Story = {
  render: args => {
    const [checked, setChecked] = createSignal(untrack(() => args.checked));
    return (
      <Switch
        {...args}
        checked={checked()}
        onChange={next => {
          setChecked(next);
          args.onChange(next);
        }}
      />
    );
  },
  play: async ({ args, canvas, userEvent, step }) => {
    const toggle = canvas.getByRole('switch', { name: 'Notifications' });
    await step('Given the switch is off', async () => {
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
    });
    await step('When I press it', async () => {
      await userEvent.click(toggle);
    });
    await step('Then it is on and reports it', async () => {
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(args.onChange).toHaveBeenCalledWith(true);
    });
  },
};
