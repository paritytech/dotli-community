// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { LightClientInvite } from './LightClientInvite.js';

const meta = {
  title: 'Host/Landing/LightClientInvite',
  component: LightClientInvite,
  args: { switching: false, onSwitch: fn() },
} satisfies Meta<typeof LightClientInvite>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a visitor on trusted providers, I press the switch and ask to switch to the light client. */
export const Switch: Story = {
  play: async ({ args, canvas, userEvent, step }) => {
    await step('When I press the switch', async () => {
      await userEvent.click(canvas.getByRole('button'));
    });

    await step('Then it asks to switch', async () => {
      await expect(args.onSwitch).toHaveBeenCalledTimes(1);
    });
  },
};

/** As a visitor whose switch runs, I see the switch busy until the reload. */
export const Switching: Story = {
  args: { switching: true },
  play: async ({ canvas, mount, step }) => {
    await step('When the invitation renders while its switch runs', async () => {
      await mount();
    });

    await step('Then the switch is busy', async () => {
      await expect(canvas.getByRole('button')).toHaveAttribute('aria-busy', 'true');
    });
  },
};
