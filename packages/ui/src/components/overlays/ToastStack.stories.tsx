// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor } from 'storybook/test';
import { pushToast, resetToastsForTests, type ToastInput } from '../../state/toasts.js';
import { ToastStack } from './ToastStack.js';

const BELL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
const toast = (text: string): ToastInput => ({ text, label: 'playground.dot', icon: BELL, dismissMs: 0 });

const meta = {
  title: 'Overlays/ToastStack',
  component: ToastStack,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ToastStack>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OneToast: Story = {
  beforeEach: () => {
    resetToastsForTests();
    pushToast(toast('Your transfer is in a block'));
    return resetToastsForTests;
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('Given exactly one toast shows', async () => {
      await expect(canvas.getAllByTestId('notif-card')).toHaveLength(1);
    });
    await step('When I dismiss it', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Dismiss' }));
    });
    await step('Then the stack is empty', async () => {
      await waitFor(() => expect(canvas.queryByTestId('notif-stack')).toBeNull());
    });
  },
};

export const ThreeToasts: Story = {
  beforeEach: () => {
    resetToastsForTests();
    pushToast(toast('Account connected'));
    pushToast(toast('Your transfer is in a block'));
    pushToast(toast('Transfer finalized'));
    return resetToastsForTests;
  },
  play: async ({ canvas, userEvent, step }) => {
    await step('Given three toasts are stacked', async () => {
      await expect(canvas.getAllByTestId('notif-card')).toHaveLength(3);
    });
    await step('When I dismiss them all', async () => {
      await userEvent.click(canvas.getByTestId('notif-close-all'));
    });
    await step('Then the stack is empty', async () => {
      await waitFor(() => expect(canvas.queryByTestId('notif-stack')).toBeNull());
    });
  },
};
