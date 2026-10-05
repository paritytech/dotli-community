// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { isPhoneViewport } from '../../phone-viewport.js';
import { SheetHead } from './SheetHead.js';

const meta = {
  title: 'Primitives/SheetHead',
  component: SheetHead,
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { docs: { story: { inline: false, height: '120px' } } },
  args: {
    title: 'Network',
    surface: () => undefined,
    onDismiss: fn(),
    closeLabel: 'Close',
    testId: 'sheet-head',
    titleTestId: 'sheet-title',
    closeTestId: 'sheet-close',
  },
} satisfies Meta<typeof SheetHead>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvas, userEvent, step }) => {
    // The workshop sizes its frame for the story's viewport only after the
    // first render, so the play waits for it.
    await step('Given the phone viewport', async () => {
      await waitFor(() => expect(isPhoneViewport()).toBe(true));
    });
    await step('When I press Close', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Close' }));
    });
    await step('Then the sheet is dismissed', async () => {
      await expect(args.onDismiss).toHaveBeenCalledOnce();
    });
  },
};
