// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush } from 'solid-js';
import { cleanup as unmountAll } from '@solidjs/testing-library';
import {
  setBackend,
  setCacheSettings,
  setNetwork,
  setPolkaVmAppsEnabled,
  type Backend,
  type CacheSettings,
  type Network,
} from '@dotli/config';

import { SettingsPopover } from '../../../src/components/shell/SettingsPopover.js';
import { initSettingsStore } from '../../../src/state/settings.js';
import { initTheme } from '../../../src/theme-controller.js';
import { renderComponent, resetStores, waitForContent } from '../../helpers/solid.js';
import { renderTopbar, tapMoreRow } from './topbar-harness.js';
import type * as SettingsActionsModule from '../../../src/settings-actions.js';
import type * as NetworkModule from '../../../../config/src/network.js';
import { byId, byTestId, query } from '../../support.js';
import type * as ReceivingModule from '../../../src/receiving.js';
import { stubPhoneViewport } from '../../helpers/viewport.js';
import { stubColorScheme } from '../../helpers/color-scheme.js';
import { useFloatingSurfaces } from '../../helpers/floating.js';

const actions = vi.hoisted(() => ({
  applyAndReset: vi.fn(),
}));
vi.mock('../../../src/settings-actions.js', async importOriginal => {
  const actual = await importOriginal<typeof SettingsActionsModule>();
  return {
    ...actual,
    applyAndReset: actions.applyAndReset,
  };
});

const receiving = vi.hoisted(() => ({
  receivingStatus: vi.fn(),
  enableReceivingPush: vi.fn(),
  revokeReceiving: vi.fn(),
}));
vi.mock('../../../src/receiving.js', async importOriginal => ({
  ...(await importOriginal<typeof ReceivingModule>()),
  ...receiving,
}));

const networks = vi.hoisted(() => ({
  enabled: null as ReturnType<typeof NetworkModule.getEnabledNetworks> | null,
}));
vi.mock('../../../../config/src/network.js', async importOriginal => {
  const actual = await importOriginal<typeof NetworkModule>();
  return {
    ...actual,
    getEnabledNetworks: () => networks.enabled ?? actual.getEnabledNetworks(),
  };
});

const DEFAULT_CACHE = {
  skipCidCache: false,
  skipArchiveCache: false,
  skipWorkerCache: false,
};

let cleanups: (() => void)[] = [];

// Transformed up front: on a loaded CI runner the cold transform outlasts waitForContent's wait.
beforeAll(async () => {
  await import('../../../src/components/shell/SettingsContent.js');
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  actions.applyAndReset.mockReset();
  actions.applyAndReset.mockResolvedValue(undefined);
  receiving.receivingStatus.mockReset();
  receiving.receivingStatus.mockResolvedValue({ supported: true, enabled: false, message: '' });
  receiving.enableReceivingPush.mockReset();
  receiving.enableReceivingPush.mockResolvedValue(undefined);
  receiving.revokeReceiving.mockReset();
  receiving.revokeReceiving.mockResolvedValue(undefined);
  networks.enabled = null;
  setPolkaVmAppsEnabled(true);
});

afterEach(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups = [];
  resetStores();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-pref');
});

async function settle(): Promise<void> {
  flush();
  await Promise.resolve();
  flush();
}

function isOpen(): boolean {
  return document.getElementById('mode-popover')?.hasAttribute('data-open') === true;
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(byId('mode-popover').querySelectorAll<HTMLButtonElement>('button')).find(
    b => b.textContent === text,
  );
  if (found === undefined) {
    throw new Error(`no "${text}" button`);
  }
  return found;
}

function applyButton(): HTMLButtonElement {
  return query(document, '[data-testid="mode-apply-row"] button', HTMLButtonElement);
}

function toggle(label: string): HTMLButtonElement {
  return query(document, `[role="switch"][aria-label="${label}"]`, HTMLButtonElement);
}

function radio(name: string, value: string): HTMLInputElement {
  return query(document, `input[name="${name}"][value="${value}"]`, HTMLInputElement);
}

async function renderPopover({ seed = true } = {}): Promise<void> {
  if (seed) {
    initSettingsStore();
  }
  const { unmount } = renderComponent(() => (
    <div>
      <SettingsPopover />
      <button id="outside" type="button">
        Outside
      </button>
    </div>
  ));
  cleanups.push(unmount);
  await settle();
}

async function openPopover(): Promise<void> {
  byId('mode-button').click();
  await settle();
  expect(isOpen()).toBe(true);
  await waitForContent('mode-popover');
  await settle();
}

async function showCategory(category: Category): Promise<void> {
  byTestId(`settings-category-${category}`).click();
  await settle();
}

function selectedCategory(): string | null {
  return byTestId('settings-categories').querySelector('[aria-pressed="true"]')?.getAttribute('data-testid') ?? null;
}

/** Saved settings seeded by the host before opening. */
interface Settings {
  chain: Backend;
  network: Network;
  cache: CacheSettings;
  enabledNetworks: Network[];
  sharedWorkerSupported: boolean;
  debugOn: boolean;
}

type Category = 'general' | 'network' | 'advanced';

function expectPopoverMatches(
  settings: Settings,
  { sheet = false, category = 'general' }: { sheet?: boolean; category?: Category } = {},
): void {
  const popover = byId('mode-popover');
  expect(popover.getAttribute('role')).toBe('dialog');
  expect(popover.getAttribute('aria-label')).toBe('Settings');
  if (sheet) {
    expect(popover.getAttribute('aria-modal')).toBe('true');
  }
  expect(selectedCategory()).toBe(`settings-category-${category}`);
  expect(applyButton().disabled).toBe(true);

  if (category === 'general') {
    expect(query(popover, '[role="radiogroup"][aria-label="Theme"]')).toBeDefined();
  } else if (category === 'network') {
    if (settings.enabledNetworks.length > 1) {
      for (const network of settings.enabledNetworks) {
        expect(radio('dotli-network', network).checked).toBe(network === settings.network);
      }
    } else {
      expect(popover.querySelector('input[name="dotli-network"]')).toBeNull();
    }
    for (const backend of ['smoldot-direct', 'smoldot-shared-worker', 'rpc-gateway'] as const) {
      const choice = radio('dotli-backend', backend);
      expect(choice.checked).toBe(backend === settings.chain);
      expect(choice.disabled).toBe(backend === 'smoldot-shared-worker' && !settings.sharedWorkerSupported);
    }
  } else {
    expect(toggle('dotNS cache').getAttribute('aria-checked')).toBe(String(!settings.cache.skipCidCache));
    expect(toggle('Archive cache').getAttribute('aria-checked')).toBe(String(!settings.cache.skipArchiveCache));
    expect(toggle('Worker cache').getAttribute('aria-checked')).toBe(String(!settings.cache.skipWorkerCache));
    expect(toggle('PolkaVM apps').getAttribute('aria-checked')).toBe('true');
    expect(byTestId('mode-receiving-enable', popover, HTMLButtonElement).disabled).toBe(false);
    expect(byTestId('mode-receiving-revoke', popover, HTMLButtonElement).disabled).toBe(false);
    expect(popover.querySelector('[data-testid="mode-debug-row"]') !== null).toBe(!settings.debugOn);
  }
}

function expectModeButton(open: boolean): void {
  const button = byId('mode-button');
  expect(button.getAttribute('title')).toBe('Settings');
  expect(button.getAttribute('aria-label')).toBe('Settings');
  expect(button.getAttribute('aria-haspopup')).toBe('dialog');
  expect(button.getAttribute('aria-expanded')).toBe(String(open));
  expect(button.getAttribute('aria-controls')).toBe('mode-popover');
}

useFloatingSurfaces();

describe('The settings popover island', () => {
  it('As a dotli user, the closed button and popover have their ids, labels and ARIA state', async () => {
    // When
    await renderPopover();

    // Then
    expectModeButton(false);
    expect(byId('mode-button').hasAttribute('data-badge')).toBe(false);
    // The shared Popover's surface is in the page only from its first opening or idle preload.
    expect(document.getElementById('mode-popover')).toBeNull();
  });

  it('As a visitor on trusted providers, the button carries the trusted-provider mark', async () => {
    // Given
    setBackend('rpc-gateway');

    // When
    await renderPopover();

    // Then
    expectModeButton(false);
    expect(byId('mode-button').hasAttribute('data-badge')).toBe(true);
  });

  it('As the host booting, an island mounted before the settings store is seeded reads no setting itself and follows the store once seeded', async () => {
    // Given: a saved choice the config getters would rewrite when read (no
    // shared workers here), which the boot's URL settings step must see
    // first to tell the visitor about the fallback.
    localStorage.setItem('dotli:chain-backend', 'smoldot-shared-worker');
    vi.stubGlobal('SharedWorker', undefined);

    // When
    await renderPopover({ seed: false });

    // Then
    expect(localStorage.getItem('dotli:chain-backend')).toBe('smoldot-shared-worker');
    expect(byId('mode-button').hasAttribute('data-badge')).toBe(false);

    // When: the host seeds the store.
    setBackend('rpc-gateway');
    initSettingsStore();
    await settle();

    // Then
    expect(byId('mode-button').hasAttribute('data-badge')).toBe(true);
  });

  it('As a mobile user opening it before the settings store is seeded, the sheet can be closed every way and fills in once the store is seeded', async () => {
    // Given: the islands mounted before the host seeded the settings.
    stubPhoneViewport(true);
    await renderPopover({ seed: false });

    // When
    await openPopover();

    // Then: no settings yet, but the sheet header and its close button are
    // there.
    expect(document.querySelector('[data-testid="mode-popover-sections"]')).toBeNull();
    expect(document.querySelector('[data-testid="popover-sheet-close"]')).not.toBeNull();
    expect(byId('mode-popover-content').hasAttribute('data-sheet')).toBe(true);

    // When
    press('Escape');
    await settle();

    // Then
    expect(isOpen()).toBe(false);

    // When
    await openPopover();
    byTestId('popover-sheet-close').click();
    await settle();

    // Then
    expect(isOpen()).toBe(false);

    // When: opened again, then the host seeds the store.
    await openPopover();
    setNetwork('previewnet');
    initSettingsStore();
    await settle();

    // Then: the content appears without reopening.
    const settings: Settings = {
      chain: 'smoldot-direct',
      network: 'previewnet',
      cache: DEFAULT_CACHE,
      enabledNetworks: ['paseo-next-v2', 'previewnet'],
      sharedWorkerSupported: typeof SharedWorker !== 'undefined',
      debugOn: false,
    };
    expect(isOpen()).toBe(true);
    expectPopoverMatches(settings, { sheet: true });

    // When
    await showCategory('network');

    // Then
    expectPopoverMatches(settings, { sheet: true, category: 'network' });
  });

  it('As a dotli user, I open the settings and they start on General, with the category control and the Appearance tiles', async () => {
    // Given
    stubColorScheme('dark');
    initTheme();
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(selectedCategory()).toBe('settings-category-general');
    expect(query(document, '[role="radiogroup"][aria-label="Theme"]').getAttribute('data-testid')).toBe(
      'theme-options',
    );
    expect(byTestId('theme-option-system').getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('[data-testid="mode-cache"]')).toBeNull();
    expect(document.querySelector('input[name="dotli-backend"]')).toBeNull();

    // When: switched to Advanced, then closed and opened again.
    await showCategory('advanced');
    press('Escape');
    await settle();
    await openPopover();

    // Then
    expect(selectedCategory()).toBe('settings-category-general');
    expect(document.querySelector('[data-testid="theme-options"]')).not.toBeNull();
  });

  it('As a dotli user opening it with several networks, it shows its ids, labels and ARIA state in each category', async () => {
    // Given
    setNetwork('previewnet');
    setCacheSettings({ ...DEFAULT_CACHE, skipArchiveCache: true });
    await renderPopover();
    const settings: Settings = {
      chain: 'smoldot-direct',
      network: 'previewnet',
      cache: { ...DEFAULT_CACHE, skipArchiveCache: true },
      enabledNetworks: ['paseo-next-v2', 'previewnet'],
      sharedWorkerSupported: typeof SharedWorker !== 'undefined',
      debugOn: false,
    };

    // When
    await openPopover();

    // Then
    expect(byId('mode-button').getAttribute('aria-expanded')).toBe('true');
    expectPopoverMatches(settings);

    // When
    await showCategory('network');

    // Then
    expectPopoverMatches(settings, { category: 'network' });

    // When
    await showCategory('advanced');

    // Then
    expectPopoverMatches(settings, { category: 'advanced' });
  });

  it('As a dotli user opening it with one network, in debug mode, on trusted providers and without shared workers, it shows its ids, labels and ARIA state in each category', async () => {
    // Given
    networks.enabled = ['previewnet'];
    setNetwork('previewnet');
    setBackend('rpc-gateway');
    sessionStorage.setItem('dotli:truapi-debug', '1');
    vi.stubGlobal('SharedWorker', undefined);
    await renderPopover();
    const settings: Settings = {
      chain: 'rpc-gateway',
      network: 'previewnet',
      cache: DEFAULT_CACHE,
      enabledNetworks: ['previewnet'],
      sharedWorkerSupported: false,
      debugOn: true,
    };

    // When
    await openPopover();
    await showCategory('network');

    // Then
    expectPopoverMatches(settings, { category: 'network' });

    // When
    await showCategory('advanced');

    // Then
    expectPopoverMatches(settings, { category: 'advanced' });
  });

  it('As a dotli user, a change enables Save and apply, undoing it disables it again, and Save and apply applies the draft', async () => {
    // Given
    await renderPopover();
    await openPopover();
    expect(applyButton().disabled).toBe(true);
    await showCategory('advanced');

    // When
    toggle('dotNS cache').click();
    await settle();

    // Then
    expect(toggle('dotNS cache').getAttribute('aria-checked')).toBe('false');
    expect(applyButton().disabled).toBe(false);

    // When
    toggle('dotNS cache').click();
    await settle();

    // Then
    expect(applyButton().disabled).toBe(true);

    // When
    toggle('Worker cache').click();
    toggle('PolkaVM apps').click();
    await settle();
    await showCategory('network');
    radio('dotli-network', 'previewnet').click();
    radio('dotli-backend', 'rpc-gateway').click();
    await settle();
    applyButton().click();
    await settle();

    // Then
    expect(actions.applyAndReset).toHaveBeenCalledTimes(1);
    expect(actions.applyAndReset).toHaveBeenCalledWith(
      {
        chain: 'rpc-gateway',
        network: 'previewnet',
        cache: { ...DEFAULT_CACHE, skipWorkerCache: true },
        polkaVmAppsEnabled: false,
      },
      {
        chain: 'smoldot-direct',
        network: 'paseo-next-v2',
        cache: DEFAULT_CACHE,
        polkaVmAppsEnabled: true,
      },
    );
    expect(applyButton().disabled).toBe(true);
  });

  it('As a dotli user, I change the network, look at Advanced and come back, and the change is still there for Save and apply', async () => {
    // Given
    await renderPopover();
    await openPopover();
    await showCategory('network');
    radio('dotli-network', 'previewnet').click();
    await settle();

    // When
    await showCategory('advanced');
    await showCategory('network');

    // Then
    expect(radio('dotli-network', 'previewnet').checked).toBe(true);
    expect(applyButton().disabled).toBe(false);

    // When
    applyButton().click();
    await settle();

    // Then
    expect(actions.applyAndReset).toHaveBeenCalledTimes(1);
    expect(actions.applyAndReset).toHaveBeenCalledWith(
      { chain: 'smoldot-direct', network: 'previewnet', cache: DEFAULT_CACHE, polkaVmAppsEnabled: true },
      { chain: 'smoldot-direct', network: 'paseo-next-v2', cache: DEFAULT_CACHE, polkaVmAppsEnabled: true },
    );
  });

  it('As a dotli user, I pick a theme tile in General and it applies at once without enabling Save and apply', async () => {
    // Given
    stubColorScheme('dark');
    initTheme();
    await renderPopover();
    await openPopover();

    // When
    byTestId('theme-option-light').click();
    await settle();

    // Then
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('dotli-theme')).toBe('light');
    expect(byTestId('theme-option-light').getAttribute('aria-checked')).toBe('true');
    expect(applyButton().disabled).toBe(true);
    expect(isOpen()).toBe(true);
  });

  it('As a keyboard user, picking a transport keeps the focus on the checked radio', async () => {
    // Given
    await renderPopover();
    await openPopover();
    await showCategory('network');

    // When
    radio('dotli-backend', 'rpc-gateway').click();
    await settle();

    // Then
    const checked = document.querySelector<HTMLInputElement>(
      '[role="radiogroup"][aria-label="Network transport"] input:checked',
    );
    expect(checked?.value).toBe('rpc-gateway');
    expect(document.activeElement).toBe(checked);
    expect(checked?.closest('label')?.hasAttribute('data-selected')).toBe(true);
  });

  it('As a dotli user, closing throws the draft away: the next open starts from the saved settings', async () => {
    // Given
    await renderPopover();
    await openPopover();
    await showCategory('advanced');
    toggle('Archive cache').click();
    await settle();

    // When
    press('Escape');
    await settle();
    await openPopover();
    await showCategory('advanced');

    // Then
    expect(toggle('Archive cache').getAttribute('aria-checked')).toBe('true');
    expect(applyButton().disabled).toBe(true);
  });

  it('As a dotli user, Clear all caches runs the full wipe with the saved settings', async () => {
    // Given
    setBackend('rpc-gateway');
    await renderPopover();
    await openPopover();
    await showCategory('advanced');
    toggle('dotNS cache').click();
    await settle();

    // When
    button('Clear all caches').click();
    await settle();

    // Then
    const saved = {
      chain: 'rpc-gateway',
      network: 'paseo-next-v2',
      cache: DEFAULT_CACHE,
      polkaVmAppsEnabled: true,
    };
    expect(actions.applyAndReset).toHaveBeenCalledTimes(1);
    expect(actions.applyAndReset).toHaveBeenCalledWith(saved, saved, {
      forceFullWipe: true,
    });
    const clear = query(document, '[data-testid="mode-clear-all-row"] button', HTMLButtonElement);
    expect(clear.disabled).toBe(true);

    // When: a second click does nothing.
    clear.click();
    await settle();

    // Then
    expect(actions.applyAndReset).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, a failed network reset keeps my draft and lets me retry', async () => {
    actions.applyAndReset.mockRejectedValueOnce(new Error('Receiving revocation could not be saved'));
    await renderPopover();
    await openPopover();
    await showCategory('network');
    radio('dotli-network', 'previewnet').click();
    await settle();

    applyButton().click();
    await settle();

    expect(byTestId('mode-reset-error').getAttribute('role')).toBe('alert');
    expect(applyButton().disabled).toBe(false);
    expect(radio('dotli-network', 'previewnet').checked).toBe(true);
    expect(isOpen()).toBe(true);

    applyButton().click();
    await settle();

    expect(actions.applyAndReset).toHaveBeenCalledTimes(2);
    expect(actions.applyAndReset.mock.calls[1]).toEqual(actions.applyAndReset.mock.calls[0]);
    expect(document.querySelector('[data-testid="mode-reset-error"]')).toBeNull();
  });

  it('As a dotli user, a failed full reset leaves the settings usable and lets me retry', async () => {
    actions.applyAndReset.mockRejectedValueOnce(new Error('Receiving revocation could not be saved'));
    await renderPopover();
    await openPopover();
    await showCategory('advanced');
    toggle('Archive cache').click();
    await settle();
    const clear = query(document, '[data-testid="mode-clear-all-row"] button', HTMLButtonElement);

    clear.click();
    await settle();

    expect(byTestId('mode-reset-error').getAttribute('role')).toBe('alert');
    expect(clear.disabled).toBe(false);
    expect(applyButton().disabled).toBe(false);
    expect(toggle('Archive cache').getAttribute('aria-checked')).toBe('false');

    clear.click();
    await settle();

    expect(actions.applyAndReset).toHaveBeenCalledTimes(2);
    expect(actions.applyAndReset.mock.calls[1]).toEqual(actions.applyAndReset.mock.calls[0]);
    expect(document.querySelector('[data-testid="mode-reset-error"]')).toBeNull();
  });

  it('As a dotli user, enabling receiving applies immediately and survives discarding a settings draft', async () => {
    await renderPopover();
    await openPopover();
    expect(receiving.receivingStatus).not.toHaveBeenCalled();
    await showCategory('advanced');
    expect(receiving.enableReceivingPush).not.toHaveBeenCalled();
    expect(receiving.revokeReceiving).not.toHaveBeenCalled();
    receiving.receivingStatus.mockResolvedValue({ supported: true, enabled: true, message: '' });

    byTestId('mode-receiving-enable').click();
    expect(receiving.enableReceivingPush).toHaveBeenCalledTimes(1);
    await settle();

    expect(applyButton().disabled).toBe(true);
    expect(actions.applyAndReset).not.toHaveBeenCalled();
    toggle('Worker cache').click();
    await settle();
    press('Escape');
    await settle();
    await openPopover();
    await showCategory('advanced');

    expect(toggle('Worker cache').getAttribute('aria-checked')).toBe('true');
    expect(byTestId('mode-receiving-enable', document, HTMLButtonElement).disabled).toBe(true);
    expect(applyButton().disabled).toBe(true);
    expect(actions.applyAndReset).not.toHaveBeenCalled();
    expect(receiving.revokeReceiving).not.toHaveBeenCalled();
  });

  it('As a dotli user, receiving revocation errors remain visible after status refresh and can be retried without saving settings', async () => {
    receiving.revokeReceiving.mockRejectedValueOnce(new Error('Remote revocation failed'));
    await renderPopover();
    await openPopover();
    await showCategory('advanced');

    byTestId('mode-receiving-revoke').click();
    await settle();

    expect(receiving.revokeReceiving).toHaveBeenCalledTimes(1);
    expect(byTestId('mode-receiving-error').getAttribute('role')).toBe('alert');
    expect(byTestId('mode-receiving-revoke', document, HTMLButtonElement).disabled).toBe(false);
    expect(applyButton().disabled).toBe(true);
    byTestId('mode-receiving-refresh').click();
    await settle();
    expect(byTestId('mode-receiving-error').getAttribute('role')).toBe('alert');

    byTestId('mode-receiving-revoke').click();
    await settle();

    expect(receiving.revokeReceiving).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-testid="mode-receiving-error"]')).toBeNull();
    expect(actions.applyAndReset).not.toHaveBeenCalled();
  });

  it('As a dotli user, a failed receiving status read does not prevent revocation', async () => {
    receiving.receivingStatus.mockRejectedValueOnce(new Error('Status unavailable'));
    await renderPopover();
    await openPopover();
    await showCategory('advanced');

    expect(byTestId('mode-receiving-error').getAttribute('role')).toBe('alert');
    expect(byTestId('mode-receiving-enable', document, HTMLButtonElement).disabled).toBe(true);
    expect(byTestId('mode-receiving-revoke', document, HTMLButtonElement).disabled).toBe(false);

    byTestId('mode-receiving-revoke').click();
    await settle();

    expect(receiving.revokeReceiving).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="mode-receiving-error"]')).toBeNull();
    expect(actions.applyAndReset).not.toHaveBeenCalled();
  });

  it('As a developer, Open in debug mode reloads the tab with the debug panel on', async () => {
    // Given
    const assign = vi.fn();
    vi.stubGlobal('location', {
      href: 'https://app.dot.li/path?x=1',
      assign,
    });
    await renderPopover();
    await openPopover();
    await showCategory('advanced');

    // When
    button('Open in debug mode').click();

    // Then
    expect(assign).toHaveBeenCalledWith('https://app.dot.li/path?x=1&debug=true');
  });

  it('As a screen-reader user, the button announces the dialog it opens and whether it is open', async () => {
    // Given
    await renderPopover();
    const settingsButton = byId('mode-button');

    // Then
    expect(settingsButton.getAttribute('aria-haspopup')).toBe('dialog');
    expect(settingsButton.getAttribute('aria-controls')).toBe('mode-popover');
    expect(settingsButton.getAttribute('aria-expanded')).toBe('false');

    // When
    await openPopover();

    // Then
    expect(settingsButton.getAttribute('aria-expanded')).toBe('true');
    const popover = byId('mode-popover');
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-label')).toBe('Settings');
  });

  it('As a mobile user who opened it from the More menu, closing the sheet hands focus to the More button', async () => {
    // Given: the bar has collapsed the settings button, which CSS hides, so
    // it cannot take focus; the sheet is reached through the More menu.
    stubPhoneViewport(true);
    initSettingsStore();
    await renderTopbar(() => <SettingsPopover />, 1);
    // Unmounted before the body is cleared, which its portals would not survive.
    cleanups.push(unmountAll);
    byId('mode-button').focus = () => undefined;
    await tapMoreRow('settings');
    expect(isOpen()).toBe(true);

    // When
    byTestId('popover-sheet-close').click();
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(byId('more-button'));
  });

  it('As a user who resized the window, the settings open as a sheet or a popover by the width at each opening', async () => {
    // Given: opened wide, then closed.
    const viewport = stubPhoneViewport(false);
    await renderPopover();
    await openPopover();
    expect(byId('mode-popover').getAttribute('aria-modal')).not.toBe('true');
    press('Escape');
    await settle();

    // When: narrowed, then opened again.
    viewport.set(true);
    await openPopover();

    // Then
    expect(byId('mode-popover').getAttribute('aria-modal')).toBe('true');

    // When: widened while open, then closed and opened.
    viewport.set(false);
    press('Escape');
    await settle();
    await openPopover();

    // Then
    expect(byId('mode-popover').getAttribute('aria-modal')).not.toBe('true');
  });

  it('As a phone user, the settings sheet leaves its title to the sheet header and Save and apply spans the sheet', async () => {
    // Given
    stubPhoneViewport(true);
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(byTestId('popover-sheet-title').textContent).toBe('Settings');
    expect(byId('mode-popover-content').querySelector('h2')).toBeNull();
    expect(applyButton().hasAttribute('data-block')).toBe(true);
  });

  it('As a mobile user, the settings sheet I opened from the More menu takes focus, and closing it hands focus back to the More button', async () => {
    // Given: the bar has collapsed the settings button, which CSS hides, so
    // it cannot take focus; the sheet is reached through the More menu.
    stubPhoneViewport(true);
    initSettingsStore();
    await renderTopbar(() => <SettingsPopover />, 1);
    // Unmounted before the body is cleared, which its portals would not survive.
    cleanups.push(unmountAll);
    byId('mode-button').focus = () => undefined;

    // When
    await tapMoreRow('settings');
    await settle();

    // Then
    expect(byId('more-popover').hasAttribute('data-open')).toBe(false);
    expect(isOpen()).toBe(true);
    expect(byId('mode-popover').contains(document.activeElement)).toBe(true);

    // When
    press('Escape');
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(byId('more-button'));
  });
});
