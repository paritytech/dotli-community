// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, flush } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { AppearancePicker } from './Appearance.js';
import type { ThemePreference } from '../../runtime/state/themeState.js';

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
export const NamedGroup: Story = {};

/** As a dotli user, I pick Dark and it is pressed at once. */
export const PickDarkPresses: Story = {
  beforeEach: () => {
    setTheme('light');
  },
};
