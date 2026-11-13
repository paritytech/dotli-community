// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { AccountAvatar } from './AccountAvatar.js';

const meta = {
  title: 'Entities/Account/AccountAvatar',
  component: AccountAvatar,
  parameters: { chrome: true },
  args: { session: { fullUsername: 'Ada Lovelace' }, size: 'sm' },
} satisfies Meta<typeof AccountAvatar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a signed-in user with a name, I see my initials. */
export const Initials: Story = {};

/** As a user whose session has no name, I see the user glyph. */
export const NoName: Story = {
  args: { session: { publicKey: '0x01' } },
};

/** As a user signed in with a local wallet, my avatar is marked as local. */
export const LocalWallet: Story = {
  args: { local: true, size: 'lg' },
};

/** As a screen-reader user, an avatar beside a name that already says who I am is not read twice. */
export const Decorative: Story = {
  args: { decorative: true, size: 'lg' },
};
