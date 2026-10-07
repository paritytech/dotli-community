// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush } from 'solid-js';
import { cleanup as unmountAll } from '@solidjs/testing-library';
import {
  BACKEND_LABELS,
  setBackend,
  setCacheSettings,
  setNetwork,
  NETWORK_NAME_TO_SERVICES_CONFIG,
  type Backend,
  type CacheSettings,
  type Network,
} from '@dotli/config';

import { SettingsPopover } from '../../../src/components/shell/SettingsPopover.js';
import { initSettingsStore } from '../../../src/state/settings.js';
import { popoverBody, renderComponent, resetStores, waitForContent } from '../../helpers/solid.js';
import { renderTopbar, tapMoreRow } from './topbar-harness.js';
import type * as SettingsActionsModule from '../../../src/settings-actions.js';
import type * as NetworkModule from '../../../../config/src/network.js';
import { byId, byTestId, must, query } from '../../support.js';
import { nth } from '../../helpers/nth.js';
import { stubPhoneViewport } from '../../helpers/viewport.js';
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

// The popover body's chunk, transformed here rather than in the first test
// to open it: on a loaded CI runner the cold transform outlasts
// waitForContent's wait.
beforeAll(async () => {
  await import('../../../src/components/shell/SettingsContent.js');
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  actions.applyAndReset.mockReset();
  actions.applyAndReset.mockResolvedValue(undefined);
  networks.enabled = null;
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
});

async function settle(): Promise<void> {
  flush();
  await Promise.resolve();
  flush();
}

/** Open, as the surface says; it is in the page only from its first opening. */
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

/** Open the popover, and wait for its body (its own chunk). */
async function openPopover(): Promise<void> {
  byId('mode-button').click();
  await settle();
  expect(isOpen()).toBe(true);
  await waitForContent('mode-popover');
  await settle();
}

/** What the popover reads from @dotli/config when it opens. */
interface Settings {
  chain: Backend;
  network: Network;
  cache: CacheSettings;
  enabledNetworks: Network[];
  sharedWorkerSupported: boolean;
  debugOn: boolean;
}

const tags = (el: Element): string[] => Array.from(el.children).map(child => child.tagName);

/** A section header: a div holding only its text. */
function expectHeader(el: Element | undefined, text: string): void {
  expect(el?.tagName).toBe('DIV');
  expect(el?.childElementCount).toBe(0);
  expect(el?.textContent).toBe(text);
}

/** A cache row: its label and a switch of the same name. */
function expectCacheRow(row: Element | undefined, label: string, checked: boolean): void {
  expect(tags(must(row, 'a row'))).toEqual(['SPAN', 'BUTTON']);
  expect(row?.children[0]?.textContent).toBe(label);
  const toggle = nth(must(row, 'a cache row').children, 1);
  expect(toggle.getAttribute('role')).toBe('switch');
  expect(toggle.getAttribute('aria-label')).toBe(label);
  expect(toggle.getAttribute('aria-checked')).toBe(String(checked));
}

/** A radio card: a label holding the radio (name, value, checked, disabled), its title, its chip and its description. */
function expectChoice(
  card: Element | undefined,
  name: string,
  opts: { value: string; label: string; description: string; selected: boolean; disabled?: boolean; chip?: string },
): void {
  expect(card?.tagName).toBe('LABEL');
  const input = query(must(card, 'a choice'), 'input', HTMLInputElement);
  expect(input.type).toBe('radio');
  expect(input.name).toBe(name);
  expect(input.value).toBe(opts.value);
  expect(input.checked).toBe(opts.selected);
  expect(input.disabled).toBe(opts.disabled === true);
  expect(card?.hasAttribute('data-selected')).toBe(opts.selected);
  expect(card?.hasAttribute('data-disabled')).toBe(opts.disabled === true);
  expect(card?.textContent).toBe(`${opts.label}${opts.chip ?? ''}${opts.description}`);
}

/** A labelled radio group: its caps label over the group of cards. Returns the group. */
function expectRadioGroup(section: Element, label: string): Element {
  expect(tags(section)).toEqual(['DIV', 'DIV']);
  expectHeader(section.children[0], label);
  const group = nth(section.children, 1);
  expect(group.getAttribute('role')).toBe('radiogroup');
  expect(group.getAttribute('aria-label')).toBe(label);
  return group;
}

/** The settings: network, transport and cache, then the debug button unless debug mode is on. */
function expectSections(container: Element, settings: Settings): void {
  const sections = Array.from(container.children);
  let at = 0;
  if (settings.enabledNetworks.length > 1) {
    const group = expectRadioGroup(nth(sections, at++), 'Network');
    expect(group.childElementCount).toBe(settings.enabledNetworks.length);
    settings.enabledNetworks.forEach((n, i) => {
      const cfg = NETWORK_NAME_TO_SERVICES_CONFIG[n];
      expectChoice(group.children[i], 'dotli-network', {
        value: n,
        label: cfg.label,
        description: cfg.description,
        selected: n === settings.network,
      });
    });
  }

  const transports = expectRadioGroup(nth(sections, at++), 'Network transport');
  const choices: [Backend, string][] = [
    ['smoldot-direct', 'Verified in your browser, separate for each tab'],
    ['smoldot-shared-worker', 'Verified in your browser, shared across tabs'],
    ['rpc-gateway', 'Fetched from trusted servers. Fastest, but less private'],
  ];
  expect(transports.childElementCount).toBe(choices.length);
  choices.forEach(([value, description], i) => {
    const disabled = value === 'smoldot-shared-worker' && !settings.sharedWorkerSupported;
    expectChoice(transports.children[i], 'dotli-backend', {
      value,
      label: BACKEND_LABELS[value],
      description: disabled ? 'Unavailable in this browser or private window' : description,
      selected: value === settings.chain,
      disabled,
      ...(value === 'smoldot-direct' ? { chip: 'Recommended' } : {}),
    });
  });

  const cache = nth(sections, at++);
  expect(tags(cache)).toEqual(['DIV', 'DIV', 'DIV']);
  expectHeader(cache.children[0], 'Cache');
  const well = nth(cache.children, 1);
  expect(well.getAttribute('data-testid')).toBe('mode-cache');
  expect(well.childElementCount).toBe(3);
  expectCacheRow(well.children[0], 'dotNS cache', !settings.cache.skipCidCache);
  expectCacheRow(well.children[1], 'Archive cache', !settings.cache.skipArchiveCache);
  expectCacheRow(well.children[2], 'Worker cache', !settings.cache.skipWorkerCache);
  const clearRow = nth(cache.children, 2);
  expect(clearRow.getAttribute('data-testid')).toBe('mode-clear-all-row');
  expect(tags(clearRow)).toEqual(['BUTTON']);
  expect(clearRow.children[0]?.textContent).toBe('Clear all caches');
  expect(clearRow.children[0]?.getAttribute('title')).toBe(
    'Wipe every cache, database, and worker across all origins. The app will reload from a clean baseline.',
  );
  if (!settings.debugOn) {
    const debugRow = nth(sections, at++);
    expect(debugRow.getAttribute('data-testid')).toBe('mode-debug-row');
    expect(tags(debugRow)).toEqual(['BUTTON']);
    expect(debugRow.children[0]?.textContent).toBe('Open in debug mode');
    expect(debugRow.children[0]?.getAttribute('title')).toBe(
      'Reload this tab with the debug panel and its diagnostics',
    );
  }
  expect(sections).toHaveLength(at);
}

/**
 * The open popover: the shared Popover's surface, whose body holds the
 * settings panel (its title, the settings and the footer), with their
 * ids, labels and ARIA state. A sheet leaves its title to the sheet header.
 */
function expectPopoverMatches(settings: Settings, sheet = false): void {
  const popover = byId('mode-popover');
  // A sheet is a modal layer, which labels itself by its title.
  if (sheet) {
    expect(popover.getAttribute('aria-modal')).toBe('true');
  } else {
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('tabindex')).toBe('-1');
  }
  expect(popover.getAttribute('aria-label')).toBe('Settings');
  const body = must(popoverBody('mode-popover'), '#mode-popover');
  expect(tags(body)).toEqual(['DIV']);
  const content = nth(body.children, 0);
  expect(content.id).toBe('mode-popover-content');
  expect(tags(content)).toEqual(['SECTION']);
  const panel = nth(content.children, 0);
  expect(tags(panel)).toEqual(sheet ? ['DIV', 'DIV'] : ['DIV', 'DIV', 'DIV']);
  const [head, sections, footer] = (sheet ? [undefined, ...panel.children] : Array.from(panel.children)) as [
    Element | undefined,
    Element,
    Element,
  ];
  expect(head?.querySelector('h2')?.textContent).toBe(sheet ? undefined : 'Settings');
  expect(head?.querySelector('[data-testid="mode-version"]')?.textContent).toBe(sheet ? undefined : 'v0.0.0');
  expect(sections.getAttribute('data-testid')).toBe('mode-popover-sections');
  expectSections(sections, settings);

  expect(footer.contains(byTestId('mode-apply-row'))).toBe(true);
  expect(byTestId('mode-apply-row').childElementCount).toBe(1);
  const apply = applyButton();
  expect(apply.disabled).toBe(true);
  expect(apply.dataset['variant']).toBe('primary');
  expect(apply.textContent).toBe('Save and apply');
  const hint = byTestId('mode-apply-warning');
  expect(footer.contains(hint)).toBe(true);
  expect(hint.textContent).toBe('Transport and cache changes reload the app');

  const checked = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
    .filter(input => input.checked)
    .map(input => `${input.name}=${input.value}`);
  expect(checked).toEqual([
    ...(settings.enabledNetworks.length > 1 ? [`dotli-network=${settings.network}`] : []),
    `dotli-backend=${settings.chain}`,
  ]);
}

/** The button: its label, icon and the ARIA of a popover trigger. */
function expectModeButton(open: boolean): void {
  const button = byId('mode-button');
  expect(button.getAttribute('title')).toBe('Settings');
  expect(button.getAttribute('aria-label')).toBe('Settings');
  expect(button.getAttribute('aria-haspopup')).toBe('dialog');
  expect(button.getAttribute('aria-expanded')).toBe(String(open));
  expect(button.getAttribute('aria-controls')).toBe('mode-popover');
  expect(tags(button)).toEqual(['svg']);
}

useFloatingSurfaces();

describe('The settings popover island', () => {
  it('As a dotli user, the closed button and popover have their ids, labels and ARIA state', async () => {
    // When
    await renderPopover();

    // Then
    expectModeButton(false);
    expect(byId('mode-button').hasAttribute('data-badge')).toBe(false);
    // The surface is the shared Popover's, in the page from its first opening (or idle preload).
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
    expect(isOpen()).toBe(true);
    expectPopoverMatches(
      {
        chain: 'smoldot-direct',
        network: 'previewnet',
        cache: DEFAULT_CACHE,
        enabledNetworks: ['paseo-next-v2', 'previewnet'],
        sharedWorkerSupported: typeof SharedWorker !== 'undefined',
        debugOn: false,
      },
      true,
    );
  });

  it('As a dotli user opening it with several networks, it shows its ids, labels and ARIA state', async () => {
    // Given
    setNetwork('previewnet');
    setCacheSettings({ ...DEFAULT_CACHE, skipArchiveCache: true });
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(byId('mode-button').getAttribute('aria-expanded')).toBe('true');
    expectPopoverMatches({
      chain: 'smoldot-direct',
      network: 'previewnet',
      cache: { ...DEFAULT_CACHE, skipArchiveCache: true },
      enabledNetworks: ['paseo-next-v2', 'previewnet'],
      sharedWorkerSupported: typeof SharedWorker !== 'undefined',
      debugOn: false,
    });
  });

  it('As a dotli user opening it with one network, in debug mode, on trusted providers and without shared workers, it shows its ids, labels and ARIA state', async () => {
    // Given
    networks.enabled = ['previewnet'];
    setNetwork('previewnet');
    setBackend('rpc-gateway');
    sessionStorage.setItem('dotli:truapi-debug', '1');
    vi.stubGlobal('SharedWorker', undefined);
    await renderPopover();

    // When
    await openPopover();

    // Then
    expectPopoverMatches({
      chain: 'rpc-gateway',
      network: 'previewnet',
      cache: DEFAULT_CACHE,
      enabledNetworks: ['previewnet'],
      sharedWorkerSupported: false,
      debugOn: true,
    });
  });

  it('As a dotli user, a change enables Save and apply, undoing it disables it again, and Save and apply applies the draft', async () => {
    // Given
    await renderPopover();
    await openPopover();
    expect(applyButton().disabled).toBe(true);

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
    radio('dotli-network', 'previewnet').click();
    radio('dotli-backend', 'rpc-gateway').click();
    toggle('Worker cache').click();
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
      },
      {
        chain: 'smoldot-direct',
        network: 'paseo-next-v2',
        cache: DEFAULT_CACHE,
      },
    );
    expect(applyButton().disabled).toBe(true);
    expect(applyButton().textContent).toBe('Resetting…');
  });

  it('As a keyboard user, picking a transport keeps the focus on the checked radio', async () => {
    // Given
    await renderPopover();
    await openPopover();

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
    toggle('Archive cache').click();
    await settle();

    // When
    press('Escape');
    await settle();
    await openPopover();

    // Then
    expect(toggle('Archive cache').getAttribute('aria-checked')).toBe('true');
    expect(applyButton().disabled).toBe(true);
  });

  it('As a dotli user, Clear all caches runs the full wipe with the saved settings', async () => {
    // Given
    setBackend('rpc-gateway');
    await renderPopover();
    await openPopover();
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
    };
    expect(actions.applyAndReset).toHaveBeenCalledTimes(1);
    expect(actions.applyAndReset).toHaveBeenCalledWith(saved, saved, {
      forceFullWipe: true,
    });
    const clear = query(document, '[data-testid="mode-clear-all-row"] button', HTMLButtonElement);
    expect(clear.disabled).toBe(true);
    expect(clear.textContent).toBe('Clearing…');

    // When: a second click does nothing.
    clear.click();
    await settle();

    // Then
    expect(actions.applyAndReset).toHaveBeenCalledTimes(1);
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
    expect(byId('mode-popover').tagName).toBe('DIV');
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
    expect(byId('mode-popover').tagName).toBe('DIV');
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
