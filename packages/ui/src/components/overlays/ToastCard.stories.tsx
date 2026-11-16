// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { fn } from 'storybook/test';
import type { ToastEntry } from '../../page/state/createToasts.js';
import { ToastCard } from './ToastCard.js';

const onAction = fn<() => void>().mockName('onAction');

const meta = {
  title: 'Primitives/ToastCard',
  parameters: { chrome: true },
  component: ToastCard,
  args: { entry: buildToast({}), hidden: false, depth: 0, expanded: false, single: true },
} satisfies Meta<typeof ToastCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a dotli user, I read an informational toast. */
export const Info: Story = {};
/** As a dotli user, I see a transfer toast drawn in the ok tone. */
export const Ok: Story = { args: { entry: buildToast({ tone: 'ok', label: 'Transfer finalized' }) } };
/** As a dotli user, I see a low-peers toast drawn in the warn tone. */
export const Warn: Story = {
  args: { entry: buildToast({ tone: 'warn', label: 'Peers are low on Hub', text: 'Updates may arrive late' }) },
};
/** As a dotli user, I see a failed-transaction toast drawn in the error tone. */
export const Err: Story = { args: { entry: buildToast({ tone: 'err', label: 'Transaction failed' }) } };
/** As a dotli user, I press the action on a toast and it runs. */
export const WithAction: Story = {
  args: { entry: buildToast({ action: { label: 'View', onClick: onAction } }) },
};

function buildToast(overrides: Partial<ToastEntry>): ToastEntry {
  return {
    id: 2000,
    text: 'playground.dot',
    label: 'Your transfer is in a block',
    tone: 'info',
    leaving: false,
    ...overrides,
  };
}
