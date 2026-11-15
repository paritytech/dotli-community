// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { query } from '@dotli/ui/testing';
import { openSurface, TopbarFrame } from '../../testing/stories/topbarFrame.js';
import {
  givenReset,
  resetStorySettings,
  settingsAsked,
  storySettings,
} from '../../testing/stories/settingsFixtures.js';
import { LandingSettingsItem } from './LandingSettingsItem.js';

const open = openSurface({ trigger: 'landing-settings-button', surface: 'landing-settings-popover' });

/** Stands in for the page's clear, which would reload the page and so never settles. */
const clearCache = fn<() => Promise<void>>();

function applyButton(): HTMLButtonElement {
  return query(document, '[data-testid="landing-settings-apply-row"] button', HTMLButtonElement);
}
function clearButton(): HTMLButtonElement {
  return query(document, '[data-testid="landing-settings-clear-row"] button', HTMLButtonElement);
}
function networkRadio(value: string): HTMLInputElement {
  return query(document, `input[name="dotli-network"][value="${value}"]`, HTMLInputElement);
}
function selectedCategory(): string | null | undefined {
  return document
    .querySelector('[data-testid="landing-settings-categories"] [aria-pressed="true"]')
    ?.getAttribute('data-testid');
}

type Category = 'network' | 'advanced';

async function showCategory(click: (el: Element) => Promise<void>, category: Category): Promise<void> {
  await click(query(document, `[data-testid="landing-settings-category-${category}"]`));
  await waitFor(() => expect(selectedCategory()).toBe(`landing-settings-category-${category}`));
}

/** The landing settings button and panel as the landing page composes them, given the story's settings. */
function StoryLandingSettings(): JSX.Element {
  return (
    <LandingSettingsItem
      settings={storySettings.settings}
      version={storySettings.version}
      onApply={storySettings.onApply}
      reset={storySettings.reset}
      onClearCache={clearCache}
    />
  );
}

const meta = {
  title: 'Host/Settings/Landing',
  component: StoryLandingSettings,
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  beforeEach: () => {
    resetStorySettings();
    clearCache.mockReset();
    clearCache.mockImplementation(() => new Promise<void>(() => undefined));
  },
  render: () => (
    <TopbarFrame>
      <StoryLandingSettings />
    </TopbarFrame>
  ),
} satisfies Meta<typeof StoryLandingSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a visitor on the landing page, I pick another network and Save and apply asks the page to save it. */
export const SavesANetwork: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    const click = ctx.userEvent.click;
    await open(ctx);
    await ctx.step('Then it is on Network with the saved network checked and nothing to save', async () => {
      await expect(selectedCategory()).toBe('landing-settings-category-network');
      await expect(networkRadio('paseo-next-v2').checked).toBe(true);
      await expect(applyButton()).toBeDisabled();
    });
    await ctx.step('When I pick the other network and press Save and apply', async () => {
      await click(networkRadio('previewnet'));
      await click(applyButton());
    });
    await ctx.step('Then the page was asked to save the picked network against the saved one', async () => {
      await waitFor(() => expect(settingsAsked.apply).toHaveBeenCalledTimes(1));
      await expect(settingsAsked.apply).toHaveBeenCalledWith(
        expect.objectContaining({ network: 'previewnet' }),
        expect.objectContaining({ network: 'paseo-next-v2' }),
      );
    });
  },
};

/** As a visitor on the landing page, I press Clear cache in Advanced and the page is asked to clear it. */
export const ClearsTheCache: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    const click = ctx.userEvent.click;
    await open(ctx);
    await ctx.step('Given another network picked, so Save and apply is enabled, and Advanced shown', async () => {
      await click(networkRadio('previewnet'));
      await waitFor(() => expect(applyButton()).not.toBeDisabled());
      await showCategory(click, 'advanced');
    });
    await ctx.step('When I press Clear cache', async () => {
      await click(clearButton());
    });
    await ctx.step('Then the page was asked to clear once, and both buttons wait for it', async () => {
      await expect(clearCache).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(clearButton()).toHaveTextContent('Clearing…'));
      await expect(clearButton()).toBeDisabled();
      await expect(applyButton()).toBeDisabled();
    });
  },
};

/** As a visitor on the landing page whose settings are being applied, I cannot press Clear cache. */
export const ResetDisablesClear: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenReset('applying');
  },
  play: async ctx => {
    await open(ctx);
    await ctx.step('When I switch to Advanced', async () => {
      await showCategory(ctx.userEvent.click, 'advanced');
    });
    await ctx.step('Then Clear cache is disabled and Save and apply says the reset runs', async () => {
      await expect(clearButton()).toBeDisabled();
      await expect(applyButton()).toHaveTextContent('Resetting…');
    });
  },
};
