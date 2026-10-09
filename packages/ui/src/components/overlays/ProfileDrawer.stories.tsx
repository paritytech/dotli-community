// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { mood, portraitBytes } from '../../../.storybook/profile-fixtures.js';
import type { LoadedProfile } from '../../profile/drawer.js';
import { ProfileDrawer } from './ProfileDrawer.js';

const meta = {
  title: 'Entities/ProfileDrawer',
  component: ProfileDrawer,
  // Own docs iframes, since each fixed dialog takes the focus and keys of the page it is on.
  parameters: { chrome: true, docs: { story: { inline: false, height: '720px' } } },
  args: {
    options: {
      productId: 'echat.paseo',
      contactName: 'alice.paseo',
      loadProfile: async (): Promise<LoadedProfile> => ({
        avatar: await portraitBytes(280, 'A'),
        mood: mood('hyped', 'loud'),
      }),
    },
    signal: new AbortController().signal,
    onClose: () => undefined,
  },
} satisfies Meta<typeof ProfileDrawer>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A contact's profile shared over Chat: photo, mood ring and mood. */
export const SharedOverChat: Story = {
  play: async () => {
    const body = within(document.body);
    await waitFor(async () => {
      await expect(body.getByAltText('Profile picture')).toBeVisible();
    });
    await expect(body.getByTestId('profile-drawer-contact')).toHaveTextContent('alice.paseo');
    await expect(body.getByTestId('profile-drawer-mood')).toHaveTextContent('Hyped · loud');
    await expect(body.getByTestId('profile-drawer-close')).toHaveFocus();
  },
};

export const SharedOverChatPhone: Story = {
  // A docs iframe renders at the column's width, never the phone's.
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
};

/** A mood shared without a photo: the empty circle inside the ring. */
export const MoodOnly: Story = {
  args: {
    options: {
      productId: 'echat.paseo',
      contactName: 'bob.paseo',
      loadProfile: () => Promise.resolve({ avatar: null, mood: mood('calm') }),
    },
  },
};

/** Still fetching: the spinner in the circle. */
export const Loading: Story = {
  args: {
    options: {
      productId: 'echat.paseo',
      contactName: 'carol.paseo',
      loadProfile: () => new Promise<LoadedProfile>(() => undefined),
    },
  },
};

/** Nothing shared with this host yet. */
export const NothingShared: Story = {
  args: { options: { productId: 'echat.paseo' } },
};

/** The fetch timed out: the warning status. */
const UNAVAILABLE = {
  productId: 'echat.paseo',
  contactName: 'dave.paseo',
  loadProfile: () => Promise.reject(new DOMException('Timed out', 'TimeoutError')),
};

export const Unavailable: Story = { args: { options: UNAVAILABLE } };

export const UnavailablePhone: Story = {
  tags: ['!autodocs'],
  args: { options: UNAVAILABLE },
  globals: { viewport: { value: 'phone', isRotated: false } },
};
