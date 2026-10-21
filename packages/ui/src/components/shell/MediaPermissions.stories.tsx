// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import type { CallingPermissionSetting } from '../../media-host.js';
import { MediaPermissions } from './MediaPermissions.js';

const onSwitchContainer = fn<() => void>().mockName('onSwitchContainer');
const revoke = fn<() => Promise<void>>(() => Promise.resolve()).mockName('revoke');

const calling: CallingPermissionSetting = {
  productId: 'vox.paseo',
  network: '0x77afd6190f1554ad45fd0d31aee62aacc33c6db0ea801129acb813f913e0764f',
  account: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
  status: 'Authorized',
  revoke,
};

const meta = {
  title: 'Shell/MediaPermissions',
  parameters: { chrome: true },
  component: MediaPermissions,
  args: { protectedMedia: true, calling: [calling], onSwitchContainer },
  // The width of the permissions popover's column.
  render: args => (
    <div style={{ 'max-width': '420px' }}>
      <MediaPermissions {...args} />
    </div>
  ),
} satisfies Meta<typeof MediaPermissions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProtectedWithCalling: Story = {
  play: async ({ canvas, userEvent, step }) => {
    revoke.mockClear();
    await step('When I revoke the Calling scope', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Revoke / ask again' }));
    });
    await step('Then its revocation runs', async () => {
      await expect(revoke).toHaveBeenCalledOnce();
    });
  },
};

export const LegacyCapture: Story = {
  args: { protectedMedia: false, calling: [] },
  play: async ({ canvas, userEvent, step }) => {
    onSwitchContainer.mockClear();
    await step('When I switch to protected host Media', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Use protected host Media (reloads)' }));
    });
    await step('Then the switch is requested', async () => {
      await expect(onSwitchContainer).toHaveBeenCalledOnce();
    });
  },
};
