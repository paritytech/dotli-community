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
  title: 'Primitives/ToastStack',
  component: ToastStack,
  // Own docs iframes, so each stack is fixed in its own frame and fills its own store.
  parameters: { layout: 'fullscreen', docs: { story: { inline: false, height: '320px' } } },
} satisfies Meta<typeof ToastStack>;

export default meta;
type Story = StoryObj<typeof meta>;

const showOne = () => {
  resetToastsForTests();
  pushToast(toast('Your transfer is in a block'));
  return resetToastsForTests;
};

const showThree = () => {
  resetToastsForTests();
  pushToast(toast('Account connected'));
  pushToast(toast('Your transfer is in a block'));
  pushToast(toast('Transfer finalized'));
  return resetToastsForTests;
};

export const OneToast: Story = {
  beforeEach: showOne,
  play: async ({ canvas, step }) => {
    await step('Then exactly one toast shows', async () => {
      await expect(canvas.getAllByTestId('notif-card')).toHaveLength(1);
    });
  },
};

export const ThreeToasts: Story = {
  beforeEach: showThree,
  play: async ({ canvas, step }) => {
    await step('Then three toasts are stacked', async () => {
      await expect(canvas.getAllByTestId('notif-card')).toHaveLength(3);
    });
  },
};

// Plays run in the workshop too, so the dismissals get stories of their own
// and the stacks above stay on screen.
export const DismissOne: Story = {
  beforeEach: showOne,
  play: async ({ canvas, userEvent, step }) => {
    await step('Given one toast shows', async () => {
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

export const DismissAll: Story = {
  beforeEach: showThree,
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
