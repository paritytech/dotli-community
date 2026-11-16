// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, flush } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, within } from 'storybook/test';
import { AppearancePicker } from './Appearance.js';
import type { ThemePreference } from './themeState.js';

const [theme, setThemeSignal] = createSignal<ThemePreference>('system');

function setTheme(next: ThemePreference): void {
  setThemeSignal(next);
  flush();
}

/** The picker as a page gives it the story's theme. A pick applies as the page's theme would. */
function StoryAppearance(): JSX.Element {
  return <AppearancePicker theme={theme} onTheme={setTheme} />;
}

const meta = {
  title: 'Entities/Appearance',
  component: StoryAppearance,
  tags: ['!autodocs'],
  beforeEach: () => {
    setTheme('dark');
  },
} satisfies Meta<typeof StoryAppearance>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a dotli user, I see the three themes as a named group with the current one pressed. */
export const NamedGroup: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('Then the themes are a group named Theme with Dark pressed', async () => {
      const group = canvas.getByRole('group', { name: 'Theme' });
      await expect(within(group).getAllByRole('button')).toHaveLength(3);
      await expect(canvas.getByTestId('theme-option-dark')).toHaveAttribute('aria-pressed', 'true');
    });
  },
};

/** As a dotli user, I pick Dark and it is pressed at once. */
export const PickDarkPresses: Story = {
  beforeEach: () => {
    setTheme('light');
  },
  play: async ({ canvasElement, step, userEvent }) => {
    const canvas = within(canvasElement);
    await step('When I pick Dark', async () => {
      await userEvent.click(canvas.getByTestId('theme-option-dark'));
    });
    await step('Then Dark is pressed and Light is not', async () => {
      await expect(canvas.getByTestId('theme-option-dark')).toHaveAttribute('aria-pressed', 'true');
      await expect(canvas.getByTestId('theme-option-light')).toHaveAttribute('aria-pressed', 'false');
    });
  },
};
