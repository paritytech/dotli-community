// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { resetStoryPermissions, storyPermissions } from '../../testing/stories/permissionsFixtures.js';
import { TopbarFrame } from '../../testing/stories/topbarFrame.js';
import { PermissionsItem } from './PermissionsItem.js';

/** The item as the page gives it the product's permissions. */
function StoryItem(): JSX.Element {
  return <PermissionsItem {...storyPermissions} />;
}

const meta = {
  title: 'Host/Permissions/PermissionsItem',
  component: StoryItem,
  parameters: { chrome: true, docs: { story: { inline: false, height: '240px' } } },
  beforeEach: () => {
    resetStoryPermissions();
  },
  render: () => (
    <TopbarFrame>
      <StoryItem />
    </TopbarFrame>
  ),
} satisfies Meta<typeof StoryItem>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a user, I see the lock button that opens the permissions panel. */
export const LockButton: Story = {};
