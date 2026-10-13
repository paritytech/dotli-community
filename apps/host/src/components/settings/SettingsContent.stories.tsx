// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  BACKEND_LABELS,
  NETWORK_NAME_TO_SERVICES_CONFIG,
  type Backend,
  type CacheSettings,
  type Network,
} from '@dotli/config';
import type { JSX } from '@solidjs/web';
import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { expect, waitFor, within } from 'storybook/test';
import { byId, query } from '@dotli/ui/testing';
import { expectPhone, openSurface, TopbarFrame } from '../../../.storybook/topbar-frame.js';
import {
  DEFAULT_CACHE,
  DEFAULT_SETTINGS,
  givenDebugMode,
  givenSettings,
  resetStorySettings,
  settingsAsked,
  storySettings,
} from '../../../.storybook/settings-fixtures.js';
import { SettingsItem } from '../topbar/items.js';

const open = openSurface({ trigger: 'mode-button', surface: 'mode-popover' });

const isOpen = (): boolean => document.getElementById('mode-popover')?.hasAttribute('data-open') === true;
const applyButton = (): HTMLButtonElement =>
  query(document, '[data-testid="mode-apply-row"] button', HTMLButtonElement);
const toggle = (label: string): HTMLButtonElement =>
  query(document, `[role="switch"][aria-label="${label}"]`, HTMLButtonElement);
const radio = (name: string, value: string): HTMLInputElement =>
  query(document, `input[name="${name}"][value="${value}"]`, HTMLInputElement);
const selectedCategory = (): string | null | undefined =>
  document.querySelector('[data-testid="settings-categories"] [aria-pressed="true"]')?.getAttribute('data-testid');

type Category = 'general' | 'network' | 'advanced';

async function showCategory(click: (el: Element) => Promise<void>, category: Category): Promise<void> {
  await click(query(document, `[data-testid="settings-category-${category}"]`));
  await waitFor(() => expect(selectedCategory()).toBe(`settings-category-${category}`));
}

/** What the popover shows for. */
interface Shown {
  chain: Backend;
  network: Network;
  cache: CacheSettings;
  enabledNetworks: Network[];
  sharedWorkerSupported: boolean;
  debugOn: boolean;
}

/** One choice card: its radio, its selection and its words. */
async function expectChoice(
  name: string,
  value: string,
  opts: { label: string; description: string; selected: boolean; disabled?: boolean; chip?: string },
): Promise<void> {
  const input = radio(name, value);
  const card = input.closest('label');
  await expect(input.checked).toBe(opts.selected);
  await expect(input.disabled).toBe(opts.disabled === true);
  await expect(card?.hasAttribute('data-selected')).toBe(opts.selected);
  await expect(card?.hasAttribute('data-disabled')).toBe(opts.disabled === true);
  await expect(card?.textContent).toBe(`${opts.label}${opts.chip ?? ''}${opts.description}`);
}

/** The category control, then only the selected category's sections, then the footer. */
async function expectSections(shown: Shown, category: Category): Promise<void> {
  const categories = query(document, '[data-testid="settings-categories"]');
  await expect(categories).toHaveAttribute('role', 'group');
  await expect(categories).toHaveAttribute('aria-label', 'Settings category');
  await expect([...categories.children].map(b => b.textContent)).toEqual(['General', 'Network', 'Advanced']);
  await expect(selectedCategory()).toBe(`settings-category-${category}`);
  const sections = query(document, '[data-testid="mode-popover-sections"]');
  const theme = sections.querySelector('[role="radiogroup"][aria-label="Theme"]');
  const transports = sections.querySelector('[role="radiogroup"][aria-label="Network transport"]');
  const networks = sections.querySelector('[role="radiogroup"][aria-label="Network"]');
  const cache = sections.querySelector('[data-testid="mode-cache"]');
  await expect(theme !== null).toBe(category === 'general');
  await expect(transports !== null).toBe(category === 'network');
  await expect(cache !== null).toBe(category === 'advanced');
  if (category === 'general') {
    await expect(theme).toHaveAttribute('data-testid', 'theme-options');
  }
  if (category === 'network') {
    await expect(networks === null).toBe(shown.enabledNetworks.length < 2);
    if (networks !== null) {
      for (const n of shown.enabledNetworks) {
        const cfg = NETWORK_NAME_TO_SERVICES_CONFIG[n];
        await expectChoice('dotli-network', n, {
          label: cfg.label,
          description: cfg.description,
          selected: n === shown.network,
        });
      }
    }
    const choices: [Backend, string][] = [
      ['smoldot-direct', 'Verified in your browser, separate for each tab'],
      ['smoldot-shared-worker', 'Verified in your browser, shared across tabs'],
      ['rpc-gateway', 'Fetched from trusted servers. Fastest, but less private'],
    ];
    await expect(transports?.querySelectorAll('input')).toHaveLength(choices.length);
    for (const [value, description] of choices) {
      const disabled = value === 'smoldot-shared-worker' && !shown.sharedWorkerSupported;
      await expectChoice('dotli-backend', value, {
        label: BACKEND_LABELS[value],
        description: disabled ? 'Unavailable in this browser or private window' : description,
        selected: value === shown.chain,
        disabled,
        ...(value === 'smoldot-direct' ? { chip: 'Recommended' } : {}),
      });
    }
  }
  if (category === 'advanced') {
    for (const [label, on] of [
      ['dotNS cache', !shown.cache.skipCidCache],
      ['Archive cache', !shown.cache.skipArchiveCache],
      ['Worker cache', !shown.cache.skipWorkerCache],
    ] as const) {
      await expect(toggle(label)).toHaveAttribute('aria-checked', String(on));
    }
    const clear = query(document, '[data-testid="mode-clear-all-row"] button');
    await expect(clear).toHaveTextContent('Clear all caches');
    await expect(clear).toHaveAttribute(
      'title',
      'Wipe every cache, database, and worker across all origins. The app will reload from a clean baseline.',
    );
    const debug = document.querySelector('[data-testid="mode-debug-row"] button');
    await expect(debug === null).toBe(shown.debugOn);
    if (debug !== null) {
      await expect(debug).toHaveTextContent('Open in debug mode');
      await expect(debug).toHaveAttribute('title', 'Reload this tab with the debug panel and its diagnostics');
    }
  }
  await expect(applyButton()).toBeDisabled();
  await expect(applyButton()).toHaveAttribute('data-variant', 'primary');
  await expect(applyButton()).toHaveTextContent('Save and apply');
  await expect(query(document, '[data-testid="mode-apply-warning"]')).toHaveTextContent(
    'Transport and cache changes reload the app',
  );
}

/** The settings button and panel as the host composes them, given the story's settings. */
function StorySettings(): JSX.Element {
  return <SettingsItem {...storySettings} />;
}

const meta = {
  title: 'Host/Settings',
  component: StorySettings,
  parameters: { chrome: true, docs: { story: { inline: false, height: '360px' } } },
  beforeEach: () => {
    resetStorySettings();
  },
  render: () => (
    <TopbarFrame>
      <StorySettings />
    </TopbarFrame>
  ),
} satisfies Meta<typeof StorySettings>;

export default meta;
type Story = StoryObj<typeof meta>;

const DEFAULTS: Shown = {
  chain: 'smoldot-direct',
  network: 'paseo-next-v2',
  cache: DEFAULT_CACHE,
  enabledNetworks: ['paseo-next-v2', 'previewnet'],
  sharedWorkerSupported: true,
  debugOn: false,
};

/** As a dotli user, the button announces the settings dialog it opens and whether it is open, with no trusted mark. */
export const Open: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    const button = byId('mode-button');
    await ctx.step('Given the closed button with its labels and ARIA state', async () => {
      await expect(button).toHaveAttribute('title', 'Settings');
      await expect(button).toHaveAttribute('aria-label', 'Settings');
      await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      await expect(button).toHaveAttribute('aria-controls', 'mode-popover');
      await expect(button).not.toHaveAttribute('data-badge');
    });
    await open(ctx);
    await ctx.step('Then it is the open dialog named Settings, with its heading and version', async () => {
      await expect(button).toHaveAttribute('aria-expanded', 'true');
      const popover = byId('mode-popover');
      await expect(popover).toHaveAttribute('role', 'dialog');
      await expect(popover).toHaveAttribute('tabindex', '-1');
      await expect(popover).toHaveAttribute('aria-label', 'Settings');
      await expect(byId('mode-popover-content').querySelector('h2')).toHaveTextContent('Settings');
      await expect(query(document, '[data-testid="mode-version"]')).toHaveTextContent('v0.0.0');
    });
  },
};

/** As a phone user, the settings sheet leaves its title to the sheet header and Save and apply sits in its foot. */
export const OpenPhone: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ctx => {
    await expectPhone(ctx.step);
    await open(ctx);
    await ctx.step(
      'Then the sheet header says Settings, the body has no heading, and Save spans the foot',
      async () => {
        const sheet = byId('mode-popover');
        await expect(sheet).toHaveAttribute('aria-modal', 'true');
        await expect(within(sheet).getByTestId('popover-sheet-title')).toHaveTextContent('Settings');
        await expect(byId('mode-popover-content').querySelector('h2')).toBeNull();
        await expect(applyButton()).toHaveAttribute('data-block');
      },
    );
  },
};

/** As a visitor on trusted providers, the button carries the trusted-provider mark. */
export const TrustedMark: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenSettings({ ...DEFAULT_SETTINGS, backend: 'rpc-gateway', verified: false });
  },
  play: async ({ step }) => {
    await step('Then the button carries the mark', async () => {
      await expect(byId('mode-button')).toHaveAttribute('data-badge');
    });
  },
};

/** As the host booting, a button mounted before the settings are read has no mark, and follows them once read. */
export const UnreadSettingsHaveNoMark: Story = {
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

/** As a mobile user opening it before the settings store is seeded, the sheet can be closed every way and fills in once the store is seeded. */
export const UnseededPhoneClosesEveryWay: Story = {
  tags: ['!autodocs'],
  globals: { viewport: { value: 'phone', isRotated: false } },
  beforeEach: () => {
    givenSettings(null);
  },
  play: async ctx => {
    await expectPhone(ctx.step);
    const press = async (): Promise<void> => {
      await ctx.userEvent.click(byId('mode-button'));
      await waitFor(() => expect(isOpen()).toBe(true));
    };
    await ctx.step('When I open it before the store is seeded', press);
    await ctx.step('Then there are no settings yet, but the sheet head and its Close are there', async () => {
      await expect(document.querySelector('[data-testid="mode-popover-sections"]')).toBeNull();
      await waitFor(() => expect(document.querySelector('[data-testid="popover-sheet-close"]')).not.toBeNull());
      await expect(byId('mode-popover-content')).toHaveAttribute('data-sheet');
    });
    await ctx.step('When I press Escape', async () => {
      await ctx.userEvent.keyboard('{Escape}');
    });
    await ctx.step('Then it closed', async () => {
      await waitFor(() => expect(isOpen()).toBe(false));
    });
    await ctx.step('When I open it again and press Close', async () => {
      await press();
      await ctx.userEvent.click(query(document, '[data-testid="popover-sheet-close"]'));
    });
    await ctx.step('Then it closed', async () => {
      await waitFor(() => expect(isOpen()).toBe(false));
    });
    await ctx.step('When I open it again and the host reads the settings', async () => {
      await press();
      givenSettings({ ...DEFAULT_SETTINGS, network: 'previewnet' });
    });
    const shown = { ...DEFAULTS, network: 'previewnet' as const };
    await ctx.step('Then the settings fill in without reopening', async () => {
      await waitFor(() => expect(document.querySelector('[data-testid="mode-popover-sections"]')).not.toBeNull());
      await expect(isOpen()).toBe(true);
      await expectSections(shown, 'general');
    });
    await ctx.step('And the Network category shows them too', async () => {
      await showCategory(ctx.userEvent.click, 'network');
      await expectSections(shown, 'network');
    });
  },
};

/** As a dotli user, I open the settings and they start on General, with the Appearance tiles, every time I open them. */
export const StartsOnGeneral: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    await open(ctx);
    await ctx.step('Then General shows the theme tiles with System checked, and nothing else', async () => {
      await expect(selectedCategory()).toBe('settings-category-general');
      await expect(query(document, '[data-testid="theme-option-system"]')).toHaveAttribute('aria-checked', 'true');
      await expect(document.querySelector('[data-testid="mode-cache"]')).toBeNull();
      await expect(document.querySelector('input[name="dotli-backend"]')).toBeNull();
    });
    await ctx.step('When I switch to Advanced, close and open again', async () => {
      await showCategory(ctx.userEvent.click, 'advanced');
      await ctx.userEvent.keyboard('{Escape}');
      await waitFor(() => expect(isOpen()).toBe(false));
      await ctx.userEvent.click(byId('mode-button'));
      await waitFor(() => expect(isOpen()).toBe(true));
    });
    await ctx.step('Then it is back on General', async () => {
      await waitFor(() => expect(selectedCategory()).toBe('settings-category-general'));
      await expect(document.querySelector('[data-testid="theme-options"]')).not.toBeNull();
    });
  },
};

/** As a dotli user opening it with several networks, each category shows its controls, labels and ARIA state. */
export const EveryCategory: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenSettings({ ...DEFAULT_SETTINGS, network: 'previewnet', cache: { ...DEFAULT_CACHE, skipArchiveCache: true } });
  },
  play: async ctx => {
    const shown: Shown = { ...DEFAULTS, network: 'previewnet', cache: { ...DEFAULT_CACHE, skipArchiveCache: true } };
    await open(ctx);
    await ctx.step('Then General is shown', async () => {
      await expectSections(shown, 'general');
    });
    await ctx.step('And Network', async () => {
      await showCategory(ctx.userEvent.click, 'network');
      await expectSections(shown, 'network');
    });
    await ctx.step('And Advanced', async () => {
      await showCategory(ctx.userEvent.click, 'advanced');
      await expectSections(shown, 'advanced');
    });
  },
};

/** As a dotli user with one network, in debug mode, on trusted providers and without shared workers, each category shows that. */
export const OneNetworkDebugTrusted: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenSettings({
      ...DEFAULT_SETTINGS,
      backend: 'rpc-gateway',
      network: 'previewnet',
      enabledNetworks: ['previewnet'],
      sharedWorkerAvailable: false,
      verified: false,
    });
    givenDebugMode(true);
  },
  play: async ctx => {
    const shown: Shown = {
      chain: 'rpc-gateway',
      network: 'previewnet',
      cache: DEFAULT_CACHE,
      enabledNetworks: ['previewnet'],
      sharedWorkerSupported: false,
      debugOn: true,
    };
    await open(ctx);
    await ctx.step('Then Network has no network choice and the shared worker is unavailable', async () => {
      await showCategory(ctx.userEvent.click, 'network');
      await expectSections(shown, 'network');
    });
    await ctx.step('And Advanced has no debug mode row', async () => {
      await showCategory(ctx.userEvent.click, 'advanced');
      await expectSections(shown, 'advanced');
    });
  },
};

/** As a dotli user, a change enables Save and apply, undoing it disables it again, and Save and apply applies the draft. */
export const DraftEnablesSave: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    const click = ctx.userEvent.click;
    await open(ctx);
    await ctx.step('When I turn the dotNS cache off', async () => {
      await expect(applyButton()).toBeDisabled();
      await showCategory(click, 'advanced');
      await click(toggle('dotNS cache'));
    });
    await ctx.step('Then Save and apply is enabled', async () => {
      await expect(toggle('dotNS cache')).toHaveAttribute('aria-checked', 'false');
      await waitFor(() => expect(applyButton()).not.toBeDisabled());
    });
    await ctx.step('When I turn it back on', async () => {
      await click(toggle('dotNS cache'));
    });
    await ctx.step('Then Save and apply is disabled again', async () => {
      await waitFor(() => expect(applyButton()).toBeDisabled());
    });
    await ctx.step('When I change the worker cache, network and transport and save', async () => {
      await click(toggle('Worker cache'));
      await showCategory(click, 'network');
      await click(radio('dotli-network', 'previewnet'));
      await click(radio('dotli-backend', 'rpc-gateway'));
      await click(applyButton());
    });
    await ctx.step('Then the draft was applied against the saved settings, and the button says so', async () => {
      await waitFor(() => expect(settingsAsked.apply).toHaveBeenCalledTimes(1));
      await expect(settingsAsked.apply).toHaveBeenCalledWith(
        { chain: 'rpc-gateway', network: 'previewnet', cache: { ...DEFAULT_CACHE, skipWorkerCache: true } },
        { chain: 'smoldot-direct', network: 'paseo-next-v2', cache: DEFAULT_CACHE },
      );
      await expect(applyButton()).toBeDisabled();
      await expect(applyButton()).toHaveTextContent('Resetting…');
    });
  },
};

/** As a dotli user, I change the network, look at Advanced and come back, and the change is still there for Save and apply. */
export const DraftSurvivesCategories: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    const click = ctx.userEvent.click;
    await open(ctx);
    await ctx.step('When I pick previewnet, look at Advanced and come back', async () => {
      await showCategory(click, 'network');
      await click(radio('dotli-network', 'previewnet'));
      await showCategory(click, 'advanced');
      await showCategory(click, 'network');
    });
    await ctx.step('Then previewnet is still picked and Save is enabled', async () => {
      await expect(radio('dotli-network', 'previewnet').checked).toBe(true);
      await expect(applyButton()).not.toBeDisabled();
    });
    await ctx.step('When I save', async () => {
      await click(applyButton());
    });
    await ctx.step('Then the network change was applied', async () => {
      await waitFor(() => expect(settingsAsked.apply).toHaveBeenCalledTimes(1));
      await expect(settingsAsked.apply).toHaveBeenCalledWith(
        { chain: 'smoldot-direct', network: 'previewnet', cache: DEFAULT_CACHE },
        { chain: 'smoldot-direct', network: 'paseo-next-v2', cache: DEFAULT_CACHE },
      );
    });
  },
};

/** As a dotli user, I pick a theme tile in General and it is picked at once without enabling Save and apply. */
export const ThemePickedWithoutSave: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    await open(ctx);
    await ctx.step('When I pick Light', async () => {
      await ctx.userEvent.click(query(document, '[data-testid="theme-option-light"]'));
    });
    await ctx.step('Then it was picked at once, with Save still disabled and the popover open', async () => {
      await expect(settingsAsked.themes).toEqual(['light']);
      await waitFor(() =>
        expect(query(document, '[data-testid="theme-option-light"]')).toHaveAttribute('aria-checked', 'true'),
      );
      await expect(applyButton()).toBeDisabled();
      await expect(isOpen()).toBe(true);
    });
  },
};

/** As a dotli user, Open in debug mode asks the page to reload this tab with the debug panel. */
export const DebugModeAsks: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    await open(ctx);
    await ctx.step('When I press Open in debug mode in Advanced', async () => {
      await showCategory(ctx.userEvent.click, 'advanced');
      await ctx.userEvent.click(query(document, '[data-testid="mode-debug-row"] button'));
    });
    await ctx.step('Then the page was asked once, and nothing was applied', async () => {
      await expect(settingsAsked.debugMode).toBe(1);
      await expect(settingsAsked.apply).not.toHaveBeenCalled();
    });
  },
};

/** As a keyboard user, picking a transport keeps the focus on the checked radio. */
export const TransportKeepsFocus: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    await open(ctx);
    await ctx.step('When I pick the trusted transport', async () => {
      await showCategory(ctx.userEvent.click, 'network');
      await ctx.userEvent.click(radio('dotli-backend', 'rpc-gateway'));
    });
    await ctx.step('Then it is checked, selected and focused', async () => {
      const checked = query(
        document,
        '[role="radiogroup"][aria-label="Network transport"] input:checked',
        HTMLInputElement,
      );
      await expect(checked.value).toBe('rpc-gateway');
      await expect(checked).toHaveFocus();
      await expect(checked.closest('label')).toHaveAttribute('data-selected');
    });
  },
};

/** As a dotli user, closing throws the draft away: the next open starts from the saved settings. */
export const CloseDropsDraft: Story = {
  tags: ['!autodocs'],
  play: async ctx => {
    const click = ctx.userEvent.click;
    await open(ctx);
    await ctx.step('Given the archive cache turned off in the draft', async () => {
      await showCategory(click, 'advanced');
      await click(toggle('Archive cache'));
      await expect(toggle('Archive cache')).toHaveAttribute('aria-checked', 'false');
    });
    await ctx.step('When I close and open again', async () => {
      await ctx.userEvent.keyboard('{Escape}');
      await waitFor(() => expect(isOpen()).toBe(false));
      await click(byId('mode-button'));
      await waitFor(() => expect(isOpen()).toBe(true));
      await waitFor(() => expect(document.querySelector('[data-testid="settings-categories"]')).not.toBeNull());
      await showCategory(click, 'advanced');
    });
    await ctx.step('Then the saved setting shows and there is nothing to save', async () => {
      await expect(toggle('Archive cache')).toHaveAttribute('aria-checked', 'true');
      await expect(applyButton()).toBeDisabled();
    });
  },
};

/** As a dotli user, Clear all caches runs the full wipe with the saved settings, once. */
export const ClearAllUsesSaved: Story = {
  tags: ['!autodocs'],
  beforeEach: () => {
    givenSettings({ ...DEFAULT_SETTINGS, backend: 'rpc-gateway', verified: false });
  },
  play: async ctx => {
    const click = ctx.userEvent.click;
    await open(ctx);
    await ctx.step('When I change the draft, then press Clear all caches', async () => {
      await showCategory(click, 'advanced');
      await click(toggle('dotNS cache'));
      await click(query(document, '[data-testid="mode-clear-all-row"] button'));
    });
    const clear = (): HTMLButtonElement =>
      query(document, '[data-testid="mode-clear-all-row"] button', HTMLButtonElement);
    await ctx.step('Then the full wipe ran with the saved settings, and the button says so', async () => {
      const saved = { chain: 'rpc-gateway', network: 'paseo-next-v2', cache: DEFAULT_CACHE };
      await waitFor(() => expect(settingsAsked.apply).toHaveBeenCalledTimes(1));
      await expect(settingsAsked.apply).toHaveBeenCalledWith(saved, saved, { forceFullWipe: true });
      await expect(clear()).toBeDisabled();
      await expect(clear()).toHaveTextContent('Clearing…');
    });
    await ctx.step('When I try it again', () => {
      clear().click();
    });
    await ctx.step('Then nothing more ran', async () => {
      await expect(settingsAsked.apply).toHaveBeenCalledTimes(1);
    });
  },
};

/** As a user who resized the window, the settings open as a sheet or a popover by the width at each opening. */
export const WidthPicksSheetOrPopover: Story = {
  tags: ['!autodocs'],
  play: async ({ userEvent, step }) => {
    const { page } = await import('vitest/browser');
    const wide = { width: window.innerWidth, height: window.innerHeight };
    const reopen = async (): Promise<void> => {
      await userEvent.click(byId('mode-button'));
      await waitFor(() => expect(isOpen()).toBe(true));
    };
    const close = async (): Promise<void> => {
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(isOpen()).toBe(false));
    };
    try {
      await step('Given it opened wide as a popover, then closed', async () => {
        await reopen();
        await expect(byId('mode-popover')).not.toHaveAttribute('aria-modal');
        await close();
      });
      await step('When the window narrows to a phone and it opens', async () => {
        await page.viewport(390, 844);
        await reopen();
      });
      await step('Then it is a sheet', async () => {
        await expect(byId('mode-popover')).toHaveAttribute('aria-modal', 'true');
      });
      await step('When the window widens while it is open, then it is closed and opened', async () => {
        await page.viewport(wide.width, wide.height);
        await close();
        await reopen();
      });
      await step('Then it is a popover again', async () => {
        await expect(byId('mode-popover')).not.toHaveAttribute('aria-modal');
      });
    } finally {
      await page.viewport(wide.width, wide.height);
    }
  },
};
