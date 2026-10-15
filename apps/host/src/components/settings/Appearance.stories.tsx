// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, flush } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { AppearancePicker } from './Appearance.js';
import type { ThemePref } from '../../runtime/state/theme.js';

const [theme, setThemeSignal] = createSignal<ThemePref>('system');

function setTheme(next: ThemePref): void {
  setThemeSignal(next);
  flush();
}

/** What the picker asked of the page. */
const settingsAsked = { themes: [] as ThemePref[] };

/** The picker as a page gives it the story's theme. A pick applies as the page's theme would. */
function StoryAppearance(): JSX.Element {
  return (
    <AppearancePicker
      theme={theme}
      onTheme={next => {
        settingsAsked.themes.push(next);
        setTheme(next);
      }}
    />
  );
}

const meta = {
  title: 'Entities/Appearance',
  component: StoryAppearance,
  tags: ['!autodocs'],
  beforeEach: () => {
    settingsAsked.themes.length = 0;
    setTheme('dark');
  },
} satisfies Meta<typeof StoryAppearance>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a dotli user, I see the three themes as a named group with the current one pressed. */
export const NamedGroup: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('Then the options are a group named Theme', async () => {
      await expect(canvas.getByRole('group', { name: 'Theme' })).toBe(canvas.getByTestId('theme-options'));
    });
    await step('And they read Light, Dark, System with Dark pressed and the only tab stop', async () => {
      const options = canvas.getAllByRole('button');
      await expect(options.map(o => o.dataset['testid'])).toEqual([
        'theme-option-light',
        'theme-option-dark',
        'theme-option-system',
      ]);
      await expect(options.map(o => o.textContent)).toEqual(['Light', 'Dark', 'System']);
      await expect(options.map(o => o.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
      await expect(options.map(o => o.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    });
  },
};

/** As a dotli user, I pick Dark and it is pressed at once. */
export const PickDarkPresses: Story = {
  beforeEach: () => {
    setTheme('light');
  },
  play: async ({ canvasElement, userEvent, step }) => {
    const canvas = within(canvasElement);
    await step('When I pick Dark', async () => {
      await userEvent.click(canvas.getByTestId('theme-option-dark'));
    });
    await step('Then Dark was picked and is pressed', async () => {
      await expect(settingsAsked.themes).toEqual(['dark']);
      await waitFor(() => expect(canvas.getByTestId('theme-option-dark')).toHaveAttribute('aria-pressed', 'true'));
      await expect(canvas.getByTestId('theme-option-light')).toHaveAttribute('aria-pressed', 'false');
    });
  },
};
