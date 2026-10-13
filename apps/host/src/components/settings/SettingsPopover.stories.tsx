// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, flush, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { byId } from '@dotli/ui/testing';
import { openSurface, TopbarFrame } from '../../../.storybook/topbar-frame.js';
import type { SavedSettings } from './settings.js';
import { SettingsPopover } from './SettingsPopover.js';

const open = openSurface({ trigger: 'mode-button', surface: 'mode-popover' });

const VERIFIED: SavedSettings = {
  backend: 'smoldot-direct',
  cache: { skipCidCache: false, skipArchiveCache: false, skipWorkerCache: false },
  network: 'paseo-next-v2',
  enabledNetworks: ['paseo-next-v2', 'previewnet'],
  sharedWorkerAvailable: true,
  verified: true,
};

const [settings, setSettingsSignal] = createSignal<SavedSettings | null>(VERIFIED);
const [isOpen, setOpenSignal] = createSignal(false);

function givenSettings(next: SavedSettings | null): void {
  setSettingsSignal(next);
  flush();
}

function setOpen(next: boolean): void {
  setOpenSignal(next);
  flush();
}

/** The button, opened as the page would, with a body standing in for the page's panel. */
function StoryButton(): JSX.Element {
  return (
    <SettingsPopover open={isOpen} onOpenChange={setOpen} settings={settings}>
      <p data-testid="story-settings-body">Transport and cache</p>
    </SettingsPopover>
  );
}

const meta = {
  title: 'Host/Settings/SettingsPopover',
  component: StoryButton,
  parameters: { chrome: true, docs: { story: { inline: false, height: '240px' } } },
  beforeEach: () => {
    givenSettings(VERIFIED);
    setOpen(false);
  },
  render: () => (
    <TopbarFrame>
      <StoryButton />
    </TopbarFrame>
  ),
} satisfies Meta<typeof StoryButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** As a dotli user, the button announces the settings dialog it opens, which shows the body the page gives it. */
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
    await ctx.step('Then the page was told, and it is the open dialog named Settings with the body', async () => {
      await expect(untrack(isOpen)).toBe(true);
      await expect(button).toHaveAttribute('aria-expanded', 'true');
      const popover = byId('mode-popover');
      await expect(popover).toHaveAttribute('role', 'dialog');
      await expect(popover).toHaveAttribute('aria-label', 'Settings');
      await expect(within(popover).getByTestId('story-settings-body')).toHaveTextContent('Transport and cache');
    });
    await ctx.step('When the page closes it', () => {
      setOpen(false);
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
      givenSettings({ ...VERIFIED, backend: 'rpc-gateway', verified: false });
    });
    await step('Then the button carries the mark', async () => {
      await waitFor(() => expect(byId('mode-button')).toHaveAttribute('data-badge'));
    });
  },
};
