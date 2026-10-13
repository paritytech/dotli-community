// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect } from 'storybook/test';
import { AccountAvatar } from './AccountAvatar.js';

const meta = {
  title: 'Entities/Account/AccountAvatar',
  component: AccountAvatar,
  parameters: { chrome: true },
  args: { session: { fullUsername: 'Ada Lovelace' }, size: 'sm', testId: 'avatar' },
} satisfies Meta<typeof AccountAvatar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a signed-in user with a name, I see my initials. */
export const Initials: Story = {
  play: async ({ canvas, step }) => {
    await step('Then the avatar shows the initials of my full name', async () => {
      await expect(canvas.getByTestId('avatar')).toHaveTextContent('AL');
      await expect(canvas.getByTestId('avatar')).not.toHaveAttribute('data-anon');
    });
  },
};

/** As a user whose session has no name, I see the user glyph. */
export const NoName: Story = {
  args: { session: { publicKey: '0x01' } },
  play: async ({ canvas, step }) => {
    await step('Then the avatar is marked anonymous and shows the glyph', async () => {
      const avatar = canvas.getByTestId('avatar');
      await expect(avatar).toHaveAttribute('data-anon');
      await expect(avatar.querySelector('svg')).not.toBeNull();
    });
  },
};

/** As a user signed in with a local wallet, my avatar is marked as local. */
export const LocalWallet: Story = {
  args: { local: true, size: 'lg' },
  play: async ({ canvas, step }) => {
    await step('Then the avatar is marked as a local wallet', async () => {
      await expect(canvas.getByTestId('avatar')).toHaveAttribute('data-wallet', 'local');
    });
  },
};

/** As a screen-reader user, an avatar beside a name that already says who I am is not read twice. */
export const Decorative: Story = {
  args: { decorative: true, size: 'lg' },
  play: async ({ canvas, step }) => {
    await step('Then the avatar is hidden from assistive tech', async () => {
      await expect(canvas.getByTestId('avatar')).toHaveAttribute('aria-hidden', 'true');
    });
  },
};
