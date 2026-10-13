// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import type { ToastEntry } from '@dotli/ui-core';
import { BellIcon } from '../icons/BellIcon.js';
import { ToastCard } from './ToastCard.js';

const onAction = fn<() => void>().mockName('onAction');

const toast = (over: Partial<ToastEntry>): ToastEntry => ({
  id: 2000,
  text: 'Your transfer is in a block',
  label: 'playground.dot',
  icon: BellIcon,
  tone: 'info',
  leaving: false,
  ...over,
});

const meta = {
  title: 'Primitives/ToastCard',
  parameters: { chrome: true },
  component: ToastCard,
  args: { entry: toast({}), hidden: false, depth: 0, expanded: false, single: true },
} satisfies Meta<typeof ToastCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Info: Story = {};
export const Ok: Story = { args: { entry: toast({ tone: 'ok', text: 'Transfer finalized' }) } };
export const Warn: Story = { args: { entry: toast({ tone: 'warn', text: 'Peers are low on Hub' }) } };
export const Err: Story = { args: { entry: toast({ tone: 'err', text: 'Transaction failed' }) } };
export const WithAction: Story = {
  args: { entry: toast({ action: { label: 'View', onClick: onAction } }) },
  play: async ({ canvas, userEvent, step }) => {
    onAction.mockClear();
    await step('When I press the toast action', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'View' }));
    });
    await step('Then the action runs', async () => {
      await expect(onAction).toHaveBeenCalledOnce();
    });
  },
};
