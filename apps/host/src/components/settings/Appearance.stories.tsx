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

/** What the tiles asked of the page. */
const settingsAsked = { themes: [] as ThemePref[] };

/** The tiles as a page gives them the story's theme. A pick applies as the page's theme would. */
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

/** As a dotli user, I see the three theme tiles as a labelled radio group with the current theme checked. */
export const TilesAreRadioGroup: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('Then the tiles are a radio group named Theme', async () => {
      await expect(canvas.getByRole('radiogroup', { name: 'Theme' })).toBe(canvas.getByTestId('theme-options'));
    });
    await step('And they read Light, Dark, System with Dark checked and the only tab stop', async () => {
      const tiles = canvas.getAllByRole('radio');
      await expect(tiles.map(t => t.dataset['testid'])).toEqual([
        'theme-option-light',
        'theme-option-dark',
        'theme-option-system',
      ]);
      await expect(tiles.map(t => t.textContent)).toEqual(['Light', 'Dark', 'System']);
      await expect(tiles.map(t => t.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
      await expect(tiles.map(t => t.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    });
  },
};

/** As a dotli user, I pick Dark and it is checked at once. */
export const PickDarkChecks: Story = {
  beforeEach: () => {
    setTheme('light');
  },
  play: async ({ canvasElement, userEvent, step }) => {
    const canvas = within(canvasElement);
    await step('When I pick Dark', async () => {
      await userEvent.click(canvas.getByTestId('theme-option-dark'));
    });
    await step('Then Dark was picked and is checked', async () => {
      await expect(settingsAsked.themes).toEqual(['dark']);
      await waitFor(() => expect(canvas.getByTestId('theme-option-dark')).toHaveAttribute('aria-checked', 'true'));
      await expect(canvas.getByTestId('theme-option-light')).toHaveAttribute('aria-checked', 'false');
      await expect(canvas.getAllByRole('radio').map(t => t.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    });
  },
};

/** As a keyboard user, I move the choice with the arrow keys and it wraps at the ends. */
export const ArrowKeysWrap: Story = {
  play: async ({ canvasElement, userEvent, step }) => {
    const canvas = within(canvasElement);
    await step('Given focus on the checked Dark tile', () => {
      canvas.getByTestId('theme-option-dark').focus();
    });
    await step('When I press ArrowRight', async () => {
      await userEvent.keyboard('{ArrowRight}');
    });
    await step('Then System is picked and focused', async () => {
      await expect(settingsAsked.themes.at(-1)).toBe('system');
      await expect(canvas.getByTestId('theme-option-system')).toHaveFocus();
    });
    await step('When I press ArrowRight at the end', async () => {
      await userEvent.keyboard('{ArrowRight}');
    });
    await step('Then the choice wraps to Light', async () => {
      await expect(settingsAsked.themes.at(-1)).toBe('light');
      await expect(canvas.getByTestId('theme-option-light')).toHaveFocus();
    });
    await step('When I press ArrowUp at the start', async () => {
      await userEvent.keyboard('{ArrowUp}');
    });
    await step('Then the choice wraps back to System', async () => {
      await expect(settingsAsked.themes).toEqual(['system', 'light', 'system']);
      await expect(canvas.getByTestId('theme-option-system')).toHaveFocus();
    });
  },
};
