// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, untrack } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { SegmentedControl } from './SegmentedControl.js';

type Theme = 'system' | 'light' | 'dark';
const OPTIONS = [
  { value: 'system', label: 'System', testId: 'seg-system' },
  { value: 'light', label: 'Light', testId: 'seg-light' },
  { value: 'dark', label: 'Dark', testId: 'seg-dark' },
] as const satisfies readonly { value: Theme; label: string; testId: string }[];

const meta = {
  title: 'Primitives/SegmentedControl',
  component: SegmentedControl<Theme>,
  args: { label: 'Theme', options: OPTIONS, value: 'system', onChange: fn() },
} satisfies Meta<typeof SegmentedControl<Theme>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Labels: Story = {
  render: args => {
    const [value, setValue] = createSignal<Theme>(untrack(() => args.value));
    return (
      <SegmentedControl<Theme>
        {...args}
        value={value()}
        onChange={next => {
          setValue(next);
          args.onChange(next);
        }}
      />
    );
  },
  play: async ({ args, canvas, userEvent, step }) => {
    await step('Given System is pressed and I focus it', async () => {
      await expect(canvas.getByTestId('seg-system')).toHaveAttribute('aria-pressed', 'true');
      canvas.getByTestId('seg-system').focus();
    });
    await step('When I press ArrowRight, then End, then Enter', async () => {
      await userEvent.keyboard('{ArrowRight}');
      await expect(canvas.getByTestId('seg-light')).toHaveFocus();
      await userEvent.keyboard('{End}{Enter}');
    });
    await step('Then Dark is pressed and reported', async () => {
      await expect(canvas.getByTestId('seg-dark')).toHaveAttribute('aria-pressed', 'true');
      await expect(args.onChange).toHaveBeenCalledWith('dark');
    });
  },
};
