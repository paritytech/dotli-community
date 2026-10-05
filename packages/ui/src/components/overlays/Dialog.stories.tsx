// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { Button } from '../primitives/Button.js';
import { Dialog } from './Dialog.js';

const meta = {
  title: 'Overlays/Dialog',
  component: Dialog,
  // Own docs iframes: a fixed dialog over the docs page would take its focus
  // and keys, and the Light story would turn the whole page light.
  parameters: { layout: 'fullscreen', docs: { story: { inline: false, height: '420px' } } },
  args: {
    titleId: 'story-dialog-title',
    title: 'Permission Request',
    testId: 'story-dialog',
    onDismiss: fn(),
    onClose: fn(),
    children: <></>,
  },
  render: args => (
    <Dialog
      titleId={args.titleId}
      title={args.title}
      testId={args.testId}
      onDismiss={args.onDismiss}
      onClose={args.onClose}
    >
      <h2 id={args.titleId}>Permission Request</h2>
      <p>playground.dot wants to use your camera.</p>
      <Button variant="danger">Deny</Button>
      <Button variant="primary">Allow</Button>
    </Dialog>
  ),
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = {
  play: async ({ args, canvas, userEvent, step }) => {
    const dialog = canvas.getByRole('dialog', { name: 'Permission Request' });
    await step('Given focus starts inside the dialog', async () => {
      await expect(dialog.contains(document.activeElement)).toBe(true);
    });
    await step('When I Tab through both buttons and once more', async () => {
      await userEvent.tab();
      await expect(canvas.getByRole('button', { name: 'Deny' })).toHaveFocus();
      await userEvent.tab();
      await expect(canvas.getByRole('button', { name: 'Allow' })).toHaveFocus();
      await userEvent.tab();
    });
    await step('Then focus wrapped to the first button', async () => {
      await expect(canvas.getByRole('button', { name: 'Deny' })).toHaveFocus();
    });
    await step('When I press Escape', async () => {
      await userEvent.keyboard('{Escape}');
    });
    await step('Then the dialog is dismissed once', async () => {
      await expect(args.onDismiss).toHaveBeenCalledOnce();
    });
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ args, canvas, userEvent, step }) => {
    await step('When I press the sheet close button', async () => {
      await userEvent.click(canvas.getByTestId('story-dialog-sheet-close'));
    });
    await step('Then the dialog is closed', async () => {
      await expect(args.onClose).toHaveBeenCalledOnce();
    });
  },
};

export const Light: Story = { globals: { theme: 'light' } };
