// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, untrack } from 'solid-js';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn } from 'storybook/test';
import { SegmentedControl, type SegmentOption } from './SegmentedControl.js';

// The Appearance menu's glyphs, which ThemeToggle.tsx keeps to itself.
const SunGlyph = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </svg>
);
const MoonGlyph = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </svg>
);
const MonitorGlyph = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect x="2" y="3" width="20" height="14" rx="3" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

type Theme = 'system' | 'light' | 'dark';
const OPTIONS = [
  { value: 'system', label: 'System', testId: 'seg-system' },
  { value: 'light', label: 'Light', testId: 'seg-light' },
  { value: 'dark', label: 'Dark', testId: 'seg-dark' },
] as const satisfies readonly { value: Theme; label: string; testId: string }[];

const meta = {
  title: 'Primitives/SegmentedControl',
  parameters: { chrome: true },
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

// The glyphs are made per render, since one node would move between controls.
export const Icons: Story = {
  render: args => {
    const [value, setValue] = createSignal<Theme>(untrack(() => args.value));
    const options: readonly SegmentOption<Theme>[] = [
      { value: 'light', label: 'Light', icon: <SunGlyph />, testId: 'seg-light' },
      { value: 'dark', label: 'Dark', icon: <MoonGlyph />, testId: 'seg-dark' },
      { value: 'system', label: 'System', icon: <MonitorGlyph />, testId: 'seg-system' },
    ];
    return (
      <SegmentedControl<Theme>
        {...args}
        options={options}
        value={value()}
        onChange={next => {
          setValue(next);
          args.onChange(next);
        }}
      />
    );
  },
  play: async ({ args, canvas, userEvent, step }) => {
    await step('When I press Light', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Light' }));
    });
    await step('Then Light is pressed and reported', async () => {
      await expect(canvas.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
      await expect(args.onChange).toHaveBeenCalledWith('light');
    });
  },
};
