// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { LightClientInvite } from './LightClientInvite.js';

type FrameProps = {
  /** Hears each switch the invitation asks for. */
  onSwitch: () => void;
};

/** The invitation as the page binds it: a switch, once asked, runs until the reload. */
function Frame(props: FrameProps): JSX.Element {
  const [switching, setSwitching] = createSignal(false);
  return (
    <LightClientInvite
      switching={switching()}
      onSwitch={() => {
        props.onSwitch();
        setSwitching(true);
      }}
    />
  );
}

const meta = {
  title: 'Host/Landing/LightClientInvite',
  component: Frame,
  args: { onSwitch: fn() },
} satisfies Meta<typeof Frame>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a visitor on trusted providers, I press the switch twice and it switches once, busy until the reload. */
export const Switch: Story = {
  play: async ({ args, canvas, userEvent, step }) => {
    const button = canvas.getByRole('button');

    await step('When I press the switch, then press it again', async () => {
      await userEvent.click(button);
      await userEvent.click(button);
    });

    await step('Then it switches once and stays busy', async () => {
      await expect(args.onSwitch).toHaveBeenCalledTimes(1);
      await expect(button).toHaveAttribute('aria-busy', 'true');
    });
  },
};
