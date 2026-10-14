// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { byId } from '@dotli/ui/testing';
import {
  DEFAULT_SETTINGS,
  givenSettings,
  resetStorySettings,
  storySettings,
} from '../../../.storybook/settings-fixtures.js';
import { openSurface, TopbarFrame } from '../../../.storybook/topbar-frame.js';
import { SettingsItem } from './SettingsItem.js';

const open = openSurface({ trigger: 'mode-button', surface: 'mode-popover' });

/** The item as the page gives it its settings and owns whether it is open. */
function StoryItem(): JSX.Element {
  return <SettingsItem {...storySettings} />;
}

const meta = {
  title: 'Host/Settings/SettingsItem',
  component: StoryItem,
  parameters: { chrome: true, docs: { story: { inline: false, height: '240px' } } },
  beforeEach: () => {
    resetStorySettings();
  },
  render: () => (
    <TopbarFrame>
      <StoryItem />
    </TopbarFrame>
  ),
} satisfies Meta<typeof StoryItem>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a dotli user, the button announces the settings dialog it opens, which shows the settings panel. */
export const OpensBody: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    const button = byId('mode-button');
    await ctx.step('Given the closed button with its labels and ARIA state, and no mark', async () => {
      await expect(button).toHaveAttribute('title', 'Settings');
      await expect(button).toHaveAttribute('aria-label', 'Settings');
      await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      await expect(button).toHaveAttribute('aria-controls', 'mode-popover');
      await expect(button).not.toHaveAttribute('data-badge');
    });
    await open(ctx);
    await ctx.step('Then the page was told, and it is the open dialog named Settings with the panel', async () => {
      await expect(untrack(storySettings.open)).toBe(true);
      await expect(button).toHaveAttribute('aria-expanded', 'true');
      const popover = byId('mode-popover');
      await expect(popover).toHaveAttribute('role', 'dialog');
      await expect(popover).toHaveAttribute('aria-label', 'Settings');
      await expect(within(popover).getByTestId('mode-version')).toHaveTextContent('v0.0.0');
    });
    await ctx.step('When the page closes it', () => {
      storySettings.onOpenChange(false);
    });
    await ctx.step('Then it is closed', async () => {
      await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'false'));
    });
  },
};

/** As the host booting, the button has no mark before the settings are read, and marks an unverified session. */
export const UnverifiedMark: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenSettings(null);
  },
  play: async ({ step }) => {
    await step('Then there is no mark', async () => {
      await expect(byId('mode-button')).not.toHaveAttribute('data-badge');
    });
    await step('When the host reads them on trusted providers', () => {
      givenSettings({ ...DEFAULT_SETTINGS, backend: 'rpc-gateway', verified: false });
    });
    await step('Then the button carries the mark', async () => {
      await waitFor(() => expect(byId('mode-button')).toHaveAttribute('data-badge'));
    });
  },
};
