// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { resetStoryNetwork, storyNetwork } from '../../testing/stories/networkFixtures.js';
import { TopbarFrame } from '../../testing/stories/topbarFrame.js';
import { NetworkItem } from './NetworkItem.js';

/** The item as the page gives it its network. */
function StoryItem(): JSX.Element {
  return <NetworkItem {...storyNetwork} />;
}

const meta = {
  title: 'Host/Network/NetworkItem',
  component: StoryItem,
  parameters: { chrome: true, docs: { story: { inline: false, height: '240px' } } },
  beforeEach: () => {
    resetStoryNetwork();
  },
  render: () => (
    <TopbarFrame>
      <StoryItem />
    </TopbarFrame>
  ),
} satisfies Meta<typeof StoryItem>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a visitor, the network button announces the dialog named Network it opens, which shows the network panel. */
export const OpensBody: Story = {
  tags: ['!autodocs'],
};
