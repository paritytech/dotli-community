// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { isPhoneViewport } from '../../phone-viewport.js';
import { Button } from './Button.js';
import { Dialog, DialogActions, DialogBody, DialogHead } from './Dialog.js';
import { Callout } from './Well.js';

const TRASH_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>' +
  '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

const meta = {
  title: 'Primitives/Dialog',
  component: Dialog,
  // Own docs iframes: a fixed dialog over the docs page would take its focus
  // and keys.
  parameters: { chrome: true, docs: { story: { inline: false, height: '420px' } } },
  args: {
    titleId: 'story-dialog-title',
    title: 'Clear site data',
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
      <DialogHead titleId={args.titleId} title={args.title} icon={TRASH_SVG} />
      <DialogBody>
        <Callout>The site forgets its settings and signs you out.</Callout>
      </DialogBody>
      <DialogActions>
        <Button variant="secondary" block>
          Cancel
        </Button>
        <Button variant="danger" block>
          Clear
        </Button>
      </DialogActions>
    </Dialog>
  ),
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = {
  // Its play moves focus and presses Escape in a docs iframe on load.
  tags: ['!autodocs'],
  play: async ({ args, canvas, userEvent, step }) => {
    const dialog = canvas.getByRole('dialog', { name: 'Clear site data' });
    await step('Given focus starts inside the dialog', async () => {
      await expect(dialog.contains(document.activeElement)).toBe(true);
    });
    await step('When I Tab through both buttons and once more', async () => {
      await userEvent.tab();
      await expect(canvas.getByRole('button', { name: 'Cancel' })).toHaveFocus();
      await userEvent.tab();
      await expect(canvas.getByRole('button', { name: 'Clear' })).toHaveFocus();
      await userEvent.tab();
    });
    await step('Then focus wrapped to the first button', async () => {
      await expect(canvas.getByRole('button', { name: 'Cancel' })).toHaveFocus();
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
  // A docs iframe renders at the column's width, never the phone's.
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ args, canvas, userEvent, step }) => {
    // The workshop sizes its frame for the story's viewport only after the
    // first render, so the play waits for it.
    await step('Given the phone viewport', async () => {
      await waitFor(() => expect(isPhoneViewport()).toBe(true));
    });
    await step('When I press the sheet close button', async () => {
      // The dialog becomes a sheet as the frame crosses to the phone's width.
      await userEvent.click(await canvas.findByTestId('story-dialog-sheet-close'));
    });
    await step('Then the dialog is closed', async () => {
      await expect(args.onClose).toHaveBeenCalledOnce();
    });
  },
};
