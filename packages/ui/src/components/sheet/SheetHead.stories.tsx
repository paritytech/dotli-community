// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { SheetHead } from './SheetHead.js';

const meta = {
  title: 'Sheet/SheetHead',
  component: SheetHead,
  globals: { viewport: { value: 'phone', isRotated: false } },
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
    await step('When I press Close', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Close' }));
    });
    await step('Then the sheet is dismissed', async () => {
      await expect(args.onDismiss).toHaveBeenCalledOnce();
    });
  },
};
