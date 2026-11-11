// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { fn } from 'storybook/test';
import type { ToastEntry } from '../../page/state/createToasts.js';
import { BellIcon } from '../icons/BellIcon.js';
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
export const Ok: Story = { args: { entry: buildToast({ tone: 'ok', text: 'Transfer finalized' }) } };
/** As a dotli user, I see a low-peers toast drawn in the warn tone. */
export const Warn: Story = { args: { entry: buildToast({ tone: 'warn', text: 'Peers are low on Hub' }) } };
/** As a dotli user, I see a failed-transaction toast drawn in the error tone. */
export const Err: Story = { args: { entry: buildToast({ tone: 'err', text: 'Transaction failed' }) } };
/** As a dotli user, I press the action on a toast and it runs. */
export const WithAction: Story = {
  args: { entry: buildToast({ action: { label: 'View', onClick: onAction } }) },
};

function buildToast(overrides: Partial<ToastEntry>): ToastEntry {
  return {
    id: 2000,
    text: 'Your transfer is in a block',
    label: 'playground.dot',
    icon: BellIcon,
    tone: 'info',
    leaving: false,
    ...overrides,
  };
}
