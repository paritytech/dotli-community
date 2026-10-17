// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { ReceivingSection, type ReceivingView } from './ReceivingContent.js';

const onEnable = fn<() => void>().mockName('onEnable');
const onRevoke = fn<() => void>().mockName('onRevoke');
const onRefresh = fn<() => void>().mockName('onRefresh');

const view = (over: Partial<ReceivingView>): ReceivingView => ({
  status: {
    supported: true,
    enabled: false,
    message: 'Web Push is disabled. Enable it here, then authorize receiving inside a verified product.',
  },
  loading: false,
  pending: null,
  error: '',
  ...over,
});

const meta = {
  title: 'Shell/ReceivingSection',
  parameters: { chrome: true },
  component: ReceivingSection,
  args: { view: view({}), onEnable, onRevoke, onRefresh },
  // At most the width of a Settings column on wide screens.
  render: args => (
    <div style={{ 'max-width': '340px' }}>
      <ReceivingSection {...args} />
    </div>
  ),
} satisfies Meta<typeof ReceivingSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NotEnabled: Story = {
  play: async ({ canvas, userEvent, step }) => {
    onEnable.mockClear();
    await step('When I enable Web Push', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Enable Web Push' }));
    });
    await step('Then the section asks for enrollment', async () => {
      await expect(onEnable).toHaveBeenCalledOnce();
    });
  },
};

export const Enabled: Story = {
  args: {
    view: view({
      status: {
        supported: true,
        enabled: true,
        message: 'Web Push is enabled. Each verified product still requires separate receiving consent and enrollment.',
      },
    }),
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('button', { name: 'Enable Web Push' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Revoke all receiving' })).toBeEnabled();
  },
};

export const Checking: Story = { args: { view: view({ status: null, loading: true }) } };

export const Unavailable: Story = {
  args: {
    view: view({
      status: {
        supported: false,
        enabled: false,
        message: 'Background receiving is unsupported: this host has no configured receiving transport.',
      },
    }),
  },
};

export const Revoking: Story = { args: { view: view({ pending: 'revoke' }) } };

export const Failed: Story = {
  args: {
    view: view({
      status: null,
      error: 'Could not complete revocation. Review the status and try again.',
    }),
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('alert')).toHaveTextContent('Could not complete revocation');
  },
};

export const NotEnabledPhone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
};
