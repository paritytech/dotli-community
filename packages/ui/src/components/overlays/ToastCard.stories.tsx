// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import type { ToastEntry } from '../../state/toasts.js';
import { ToastCard } from './ToastCard.js';

const BELL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9m4.3 13a1.94 1.94 0 0 0 3.4 0"/></svg>';
const onAction = fn<() => void>().mockName('onAction');

const toast = (over: Partial<ToastEntry>): ToastEntry => ({
  id: 2000,
  text: 'Your transfer is in a block',
  label: 'playground.dot',
  icon: BELL,
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
