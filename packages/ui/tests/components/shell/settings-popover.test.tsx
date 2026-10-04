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
import { setBlockingModalActive } from '../../../src/state/topbar.js';
import {
  pointerPress,
  pointerPressUnfocusable,
  renderComponent,
  resetStores,
  tabTo,
  waitForContent,
} from '../../helpers/solid.js';
import { renderTopbar, tapMoreRow } from './topbar-harness.js';
import {
  buildBaseDiagnosticsRows,
  buildLightClientVersionLabel,
  packageVersions,
} from '../../../src/settings-actions.js';
import type * as SettingsActionsModule from '../../../src/settings-actions.js';
import type * as NetworkModule from '../../../../config/src/network.js';
import { byId, byTestId, must, query } from '../../support.js';
import { focusables } from '../../../src/components/focus.js';
import { nth } from '../../helpers/nth.js';

const actions = vi.hoisted(() => ({
  applyAndReset: vi.fn(),
  extraRows: [] as [label: string, value: string][],
}));
vi.mock('../../../src/settings-actions.js', async importOriginal => {
  const actual = await importOriginal<typeof SettingsActionsModule>();
  return {
    ...actual,
    applyAndReset: actions.applyAndReset,
    // Lets a test add a row the default backend does not produce, such as a node reading "n/a".
    buildBaseDiagnosticsRows: () => [...actual.buildBaseDiagnosticsRows(), ...actions.extraRows],
  };
});

// No chain answers here: the share report's block heights read "n/a".
vi.mock('../../../../protocol/src/client.js', () => ({
  isRemoteChainSupported: () => false,
}));

const rpc = vi.hoisted(() => ({ live: null as string | null }));
vi.mock('../../../../resolver/src/rpc-resolve.js', () => ({
  getConnectedAssetHubRpcEndpoint: () => rpc.live,
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
  actions.extraRows = [];
  actions.applyAndReset.mockResolvedValue(undefined);
  rpc.live = null;
  networks.enabled = null;
});

afterEach(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups = [];
  resetStores();
  // The copy test's clipboard.
  Reflect.deleteProperty(navigator, 'clipboard');
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function settle(): Promise<void> {
  flush();
  await Promise.resolve();
  flush();
}

/** Let the lazy imports and promise chains a click starts finish. */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    flush();
  }
}

function isOpen(): boolean {
  return byId('mode-popover').hasAttribute('data-open');
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

function infoRow(label: string): HTMLElement {
  const found = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="mode-info-row"]')).find(
    row => row.firstElementChild?.textContent === label,
  );
  if (found === undefined) {
    throw new Error(`no "${label}" row`);
  }
  return found;
}

/**
 * The viewport width against the CSS breakpoint where the popover becomes a
 * full-screen sheet, `(max-width: 560px)`: happy-dom cannot evaluate it.
 * Flip `narrow` to resize.
 */
function stubViewport(narrow: boolean): { narrow: boolean } {
  const viewport = { narrow };
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === '(max-width: 560px)' && viewport.narrow;
    },
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  return viewport;
}

/** The popover's controls that Tab reaches, in order. */
function tabbables(): HTMLElement[] {
  return Array.from(
    byId('mode-popover').querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'),
  ).filter(el => !(el instanceof HTMLInputElement && !el.checked));
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

/** The backdrop: the shared Popover's, open with the popover. */
function expectBackdrop(open: boolean): void {
  const backdrop = byId('mode-popover-backdrop');
  expect(backdrop.getAttribute('data-testid')).toBe('popover-backdrop');
  expect(backdrop.hasAttribute('data-open')).toBe(open);
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

/** A diagnostics row: label and value, the copy hint on the copyable ones, dense in the package list. */
function expectInfoRow(
  row: Element | undefined,
  label: string,
  value: string,
  opts: { copyable?: boolean; dense?: boolean } = {},
): void {
  expect(tags(must(row, 'a row'))).toEqual(opts.copyable === true ? ['SPAN', 'BUTTON', 'SPAN'] : ['SPAN', 'CODE']);
  expect(row?.children[0]?.textContent).toBe(label);
  expect(row?.children[1]?.textContent).toBe(value);
  expect(row?.hasAttribute('data-copyable')).toBe(opts.copyable === true);
  expect(row?.hasAttribute('data-dense')).toBe(opts.dense === true);
  expect(row?.getAttribute('title')).toBe(opts.copyable === true ? `Click to copy ${label}` : null);
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

/** The left column: network, transport and cache settings. */
function expectSettingsColumn(left: Element, settings: Settings): void {
  const sections = Array.from(left.children);
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

  const transports = expectRadioGroup(nth(sections, at++), 'Network Transport');
  const choices: [Backend, string][] = [
    ['smoldot-direct', 'Verified in your browser, separate per tab'],
    ['smoldot-shared-worker', 'Verified in your browser, shared across tabs'],
    ['rpc-gateway', 'Fetched from trusted servers, fastest but less private'],
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
  expect(sections).toHaveLength(at);
}

/** The right column: the diagnostics well, the closed Packages disclosure and the share and debug buttons. */
function expectDiagnosticsColumn(right: Element, debugOn: boolean): void {
  expect(tags(right)).toEqual(['DIV', 'DIV', 'DIV', 'DIV']);
  const [header, diagnostics, packages, actions] = Array.from(right.children) as [Element, Element, Element, Element];
  expectHeader(header, 'Diagnostics');

  expect(diagnostics.getAttribute('data-testid')).toBe('mode-diagnostics');
  const copyable = new Set(['Site', 'Relay node', 'AssetHub node', 'Bulletin Node']);
  const base = buildBaseDiagnosticsRows();
  expect(diagnostics.childElementCount).toBe(base.length);
  base.forEach(([label, value], i) => {
    expectInfoRow(diagnostics.children[i], label, value, { copyable: copyable.has(label) });
  });

  expect(packages.getAttribute('data-testid')).toBe('mode-packages-well');
  const { polkadotApi, parityTruapi } = packageVersions();
  const toggle = byTestId('mode-packages-toggle', packages, HTMLButtonElement);
  expect(toggle.type).toBe('button');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.getAttribute('aria-controls')).toBe('mode-packages');
  expect(toggle.textContent).toBe(`Packages${String(1 + polkadotApi.length + parityTruapi.length)}`);
  const list = byId('mode-packages');
  expect(list.parentElement).toBe(packages);
  expect(list.hidden).toBe(true);
  const items = Array.from(list.children);
  let at = 0;
  expectHeader(items[at++], 'Light client');
  expectInfoRow(items[at++], '@parity/truapi-provider', buildLightClientVersionLabel(), { dense: true });
  if (polkadotApi.length > 0) {
    expectHeader(items[at++], '@polkadot-api');
    for (const pkg of polkadotApi) {
      expectInfoRow(items[at++], pkg.name, pkg.version, { dense: true });
    }
  }
  if (parityTruapi.length > 0) {
    expectHeader(items[at++], '@parity/truapi');
    for (const pkg of parityTruapi) {
      expectInfoRow(items[at++], pkg.name, pkg.version, { dense: true });
    }
  }
  expect(items).toHaveLength(at);

  expect(actions.getAttribute('data-testid')).toBe('mode-diagnostic-actions');
  expect(tags(actions)).toEqual(['BUTTON', 'BUTTON']);
  const [share, debug] = Array.from(actions.children) as [HTMLButtonElement, HTMLButtonElement];
  expect(share.type).toBe('button');
  expect(share.textContent).toBe('Share diagnostic');
  expect(share.title).toBe('Open a new issue on paritytech/dotli pre-filled with these diagnostics');
  expect(debug.type).toBe('button');
  expect(debug.textContent).toBe(debugOn ? 'Exit debug mode' : 'Debug mode');
  expect(debug.title).toBe(
    debugOn
      ? 'Reload this tab with the TrUAPI debug panel disabled'
      : 'Reload this tab with the TrUAPI debug panel enabled (off again on tab close)',
  );
}

/**
 * The open popover: the shared Popover's surface, whose body holds the
 * settings panel (its title, the two columns and the footer), with their
 * ids, labels and ARIA state. A sheet leaves its title to the sheet header.
 */
function expectPopoverMatches(settings: Settings, sheet = false): void {
  const popover = byId('mode-popover');
  expect(popover.getAttribute('role')).toBe('dialog');
  expect(popover.getAttribute('aria-label')).toBe('Settings');
  expect(popover.getAttribute('tabindex')).toBe('-1');
  const body = query(popover, ':scope > [data-testid="popover-body"]');
  expect(tags(body)).toEqual(['DIV']);
  const content = nth(body.children, 0);
  expect(content.id).toBe('mode-popover-content');
  expect(tags(content)).toEqual(['SECTION']);
  const panel = nth(content.children, 0);
  expect(tags(panel)).toEqual(sheet ? ['DIV', 'DIV'] : ['DIV', 'DIV', 'DIV']);
  const [head, columns, footer] = (sheet ? [undefined, ...panel.children] : Array.from(panel.children)) as [
    Element | undefined,
    Element,
    Element,
  ];
  expect(head?.querySelector('h2')?.textContent).toBe(sheet ? undefined : 'Settings');
  expect(columns.getAttribute('data-testid')).toBe('mode-popover-columns');
  expect(tags(columns)).toEqual(['DIV', 'DIV']);
  expectSettingsColumn(nth(columns.children, 0), settings);
  expectDiagnosticsColumn(nth(columns.children, 1), settings.debugOn);

  expect(footer.contains(byTestId('mode-apply-row'))).toBe(true);
  expect(byTestId('mode-apply-row').childElementCount).toBe(1);
  const apply = applyButton();
  expect(apply.disabled).toBe(true);
  expect(apply.dataset['variant']).toBe('primary');
  expect(apply.textContent).toBe('Save and apply');
  const hint = byTestId('mode-apply-warning');
  expect(footer.contains(hint)).toBe(true);
  expect(hint.textContent).toBe('Applying reloads the app. Caches you turn off are cleared.');

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

describe('The settings popover island', () => {
  it('As a dotli user, the closed button, backdrop and popover have their ids, labels and ARIA state', async () => {
    // When
    await renderPopover();

    // Then
    expectModeButton(false);
    expect(byId('mode-button').hasAttribute('data-badge')).toBe(false);
    expectBackdrop(false);
    // The surface is the shared Popover's, and holds nothing until opened.
    expect(byId('mode-popover').getAttribute('aria-label')).toBe('Settings');
    expect(query(byId('mode-popover'), ':scope > [data-testid="popover-body"]').childElementCount).toBe(0);
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
    stubViewport(true);
    await renderPopover({ seed: false });

    // When
    await openPopover();

    // Then: no settings yet, but the sheet header and its close button are
    // there.
    expect(document.querySelector('[data-testid="mode-popover-columns"]')).toBeNull();
    expect(document.querySelector('[data-testid="popover-sheet-close"]')).not.toBeNull();
    expect(byId('mode-popover-content').hasAttribute('data-sheet')).toBe(true);

    // When
    press('Escape');
    await settle();

    // Then
    expect(isOpen()).toBe(false);

    // When
    await openPopover();
    byId('mode-popover-backdrop').click();
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
    expectBackdrop(true);
    expectPopoverMatches({
      chain: 'smoldot-direct',
      network: 'previewnet',
      cache: { ...DEFAULT_CACHE, skipArchiveCache: true },
      enabledNetworks: ['paseo-next-v2', 'previewnet'],
      sharedWorkerSupported: typeof SharedWorker !== 'undefined',
      debugOn: false,
    });
  });

  it('As a dotli user opening it with one network, in debug mode, on trusted providers, without shared workers and with package versions, it shows its ids, labels and ARIA state', async () => {
    // Given
    networks.enabled = ['previewnet'];
    setNetwork('previewnet');
    setBackend('rpc-gateway');
    sessionStorage.setItem('dotli:truapi-debug', '1');
    vi.stubGlobal('SharedWorker', undefined);
    vi.stubGlobal('__POLKADOT_API_VERSION__', '1.2.3');
    vi.stubGlobal('__POLKADOT_API_VERSIONS__', [{ name: '@polkadot-api/ws-provider', version: '0.4.0' }]);
    vi.stubGlobal('__PARITY_TRUAPI_VERSIONS__', [{ name: '@parity/truapi-host', version: '0.9.0' }]);
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
      '[role="radiogroup"][aria-label="Network Transport"] input:checked',
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

  it('As a dotli user, clicking a copyable diagnostics row copies it and flashes Copied for a second', async () => {
    // Given
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    await renderPopover();
    await openPopover();
    vi.useFakeTimers();
    const site = infoRow('Site');
    const value = query(site, 'code');

    // When
    site.click();
    await Promise.resolve();
    await Promise.resolve();
    flush();

    // Then
    expect(writeText).toHaveBeenCalledWith(window.location.host);
    expect(value.textContent).toBe('Copied');

    // When
    vi.advanceTimersByTime(1000);
    flush();

    // Then
    expect(value.textContent).toBe(window.location.host);

    // When: a row that is not copyable.
    infoRow('Build').click();
    await Promise.resolve();

    // Then
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('As a keyboard user, a copyable diagnostics row is a focusable button named Copy Site that copies and announces', async () => {
    // Given
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    await renderPopover();
    await openPopover();
    const site = infoRow('Site');
    const button = query(site, 'button', HTMLButtonElement);
    const status = query(site, '[role="status"]');
    expect(button.getAttribute('aria-label')).toBe('Copy Site');
    expect(focusables(byId('mode-popover'))).toContain(button);
    expect(infoRow('Build').querySelector('button')).toBeNull();

    // When
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    flush();

    // Then
    expect(writeText).toHaveBeenCalledWith(window.location.host);
    expect(status.textContent).toBe('Copied');
  });

  it('As a dotli user, clicking a copyable row that reads n/a copies nothing', async () => {
    // Given
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    actions.extraRows = [['Relay node', 'n/a']];
    await renderPopover();
    await openPopover();
    const row = infoRow('Relay node');
    const button = query(row, 'button', HTMLButtonElement);
    expect(query(row, 'code').textContent).toBe('n/a');

    // When
    button.click();
    await Promise.resolve();

    // Then
    expect(writeText).not.toHaveBeenCalled();
  });

  it('As a dotli user, I open Packages to read the package versions and close it again', async () => {
    // Given
    vi.stubGlobal('__POLKADOT_API_VERSIONS__', [{ name: '@polkadot-api/ws-provider', version: '0.4.0' }]);
    await renderPopover();
    await openPopover();
    const toggle = byTestId('mode-packages-toggle');

    // When
    toggle.click();
    await settle();

    // Then
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(byId('mode-packages').hidden).toBe(false);
    expect(infoRow('@polkadot-api/ws-provider').children[1]?.textContent).toBe('0.4.0');

    // When
    toggle.click();
    await settle();

    // Then
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(byId('mode-packages').hidden).toBe(true);

    // When: opened again, then the popover closed and reopened.
    toggle.click();
    await settle();
    byId('mode-popover-backdrop').click();
    await settle();
    await openPopover();

    // Then
    expect(byTestId('mode-packages-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(byId('mode-packages').hidden).toBe(true);
  });

  it('As a dotli user on trusted providers, the AssetHub row shows the node the client is connected to, in the popover and the shared report', async () => {
    // Given
    setBackend('rpc-gateway');
    rpc.live = 'wss://live.example';
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await renderPopover();

    // When
    await openPopover();
    await drain();

    // Then
    expect(infoRow('AssetHub node').querySelector('code')?.textContent).toBe('wss://live.example');

    // When
    button('Share diagnostic').click();
    await drain();

    // Then
    const url = new URL(nth(open.mock.calls, 0)[0] as string);
    expect(url.searchParams.get('body')).toContain('AssetHub node: wss://live.example');
  });

  it('As a dotli user, Share diagnostic opens a GitHub issue prefilled with the diagnostics', async () => {
    // Given
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await renderPopover();
    await openPopover();

    // When
    button('Share diagnostic').click();
    await drain();

    // Then
    expect(open).toHaveBeenCalledTimes(1);
    const [href, target, features] = nth(open.mock.calls, 0);
    const url = new URL(href as string);
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/paritytech/dotli/issues/new');
    expect(target).toBe('_blank');
    expect(features).toBe('noopener,noreferrer');
    expect(url.searchParams.get('body')).toBe(
      [
        '<!-- Describe the issue above this line; the diagnostics below are auto-filled. -->',
        '',
        '## Diagnostics',
        '',
        '```',
        `Site: ${window.location.host}`,
        'Build: 0.0.0 (dev)',
        'Network: ' + (infoRow('Network').querySelector('code')?.textContent ?? ''),
        'Network Transport: Light Client Per-Tab',
        `Browser: ${infoRow('Browser').querySelector('code')?.textContent ?? ''}`,
        '',
        'Cache:',
        '  dotNS cache: on',
        '  Archive cache: on',
        '  Worker cache: on',
        '',
        'Packages:',
        '  smoldot: unknown',
        '```',
      ].join('\n'),
    );
  });

  it('As a developer, the debug button reloads the tab with debug mode on, or off when it is on', async () => {
    // Given
    const assign = vi.fn();
    vi.stubGlobal('location', {
      href: 'https://app.dot.li/path?x=1',
      assign,
    });
    await renderPopover();
    await openPopover();

    // When
    button('Debug mode').click();

    // Then
    expect(assign).toHaveBeenCalledWith('https://app.dot.li/path?x=1&debug=true');
  });

  it('As a developer in debug mode, the debug button reloads the tab with debug mode off', async () => {
    // Given
    sessionStorage.setItem('dotli:truapi-debug', '1');
    const assign = vi.fn();
    vi.stubGlobal('location', { href: 'https://app.dot.li/', assign });
    await renderPopover();
    await openPopover();

    // When
    button('Exit debug mode').click();

    // Then
    expect(assign).toHaveBeenCalledWith('https://app.dot.li/?debug=off');
  });

  it('As a keyboard user, opening it focuses its first control, Tab loops inside, and Escape closes it, handing focus back to the button', async () => {
    // Given
    await renderPopover();

    // When
    await openPopover();

    // Then
    const focusables = Array.from(
      byId('mode-popover').querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'),
    ).filter(el => !(el instanceof HTMLInputElement && !el.checked));
    expect(document.activeElement).toBe(focusables[0]);
    nth(focusables, focusables.length - 1).focus();

    // When
    const tab = press('Tab');

    // Then: Tab loops back to the first control.
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);

    // When
    press('Escape');
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(byId('mode-popover-backdrop').hasAttribute('data-open')).toBe(false);
    expect(byId('mode-button').getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(byId('mode-button'));
  });

  it('As a screen-reader user, the button announces the dialog it opens and whether it is open', async () => {
    // Given
    await renderPopover();
    const settingsButton = byId('mode-button');
    const popover = byId('mode-popover');

    // Then
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-label')).toBe('Settings');
    expect(settingsButton.getAttribute('aria-haspopup')).toBe('dialog');
    expect(settingsButton.getAttribute('aria-controls')).toBe('mode-popover');
    expect(settingsButton.getAttribute('aria-expanded')).toBe('false');

    // When
    await openPopover();

    // Then
    expect(settingsButton.getAttribute('aria-expanded')).toBe('true');
  });

  it('As a keyboard user on desktop, Tab past the last control keeps focus in the popover and leaves it open', async () => {
    // Given
    await renderPopover();
    byId('mode-button').focus();
    await openPopover();
    expect(byId('mode-popover').contains(document.activeElement)).toBe(true);
    const controls = byId('mode-popover').querySelectorAll<HTMLElement>('button:not([disabled])');
    nth(controls, controls.length - 1).focus();
    await settle();
    expect(isOpen()).toBe(true);

    // When
    const tab = tabTo(byId('outside'));
    await settle();

    // Then
    expect(tab.defaultPrevented).toBe(true);
    expect(isOpen()).toBe(true);
    expect(byId('mode-popover').contains(document.activeElement)).toBe(true);
  });

  it('As a dotli user on desktop, a press on the backdrop closes it without handing focus back to the button', async () => {
    // Given
    await renderPopover();
    byId('mode-button').focus();
    await openPopover();

    // When: the backdrop covers the page, and takes no focus.
    pointerPressUnfocusable(byId('mode-popover-backdrop'));
    await settle();

    // Then: focus follows the press.
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it('As a mobile user who opened it from the More menu, closing the sheet hands focus to the More button', async () => {
    // Given: the bar has collapsed the settings button, which CSS hides, so
    // it cannot take focus; the sheet is reached through the More menu.
    stubViewport(true);
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

  it('As a dotli user, a click on the backdrop or outside closes it, and a click inside does not', async () => {
    // Given
    await renderPopover();
    await openPopover();

    // When
    byTestId('mode-popover-columns').click();
    await settle();

    // Then
    expect(isOpen()).toBe(true);

    // When
    byId('mode-popover-backdrop').click();
    await settle();

    // Then
    expect(isOpen()).toBe(false);

    // When
    await openPopover();
    pointerPress(byId('outside'));
    await settle();

    // Then
    expect(isOpen()).toBe(false);
  });

  it('As a dotli user, a blocking modal coming up closes it', async () => {
    // Given
    await renderPopover();
    await openPopover();

    // When
    setBlockingModalActive(true);
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(byId('mode-popover-backdrop').hasAttribute('data-open')).toBe(false);
  });

  it('As a mobile user, the full-screen settings sheet is a modal dialog: it traps Tab, keeps focus, locks the page scroll and says it is modal', async () => {
    // Given
    stubViewport(true);
    document.body.style.overflow = '';
    await renderPopover();
    byId('mode-button').focus();

    // When
    await openPopover();

    // Then
    const popover = byId('mode-popover');
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-modal')).toBe('true');
    expect(popover.contains(document.activeElement)).toBe(true);
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(true);

    // When: Tab on the last control.
    const controls = tabbables();
    nth(controls, controls.length - 1).focus();
    const tab = press('Tab');

    // Then: it wraps to the first.
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls[0]);

    // When: focus lands outside, as a modal dialog never lets it.
    byId('outside').focus();
    await settle();

    // Then: a dialog does not close on focus leaving it.
    expect(isOpen()).toBe(true);

    // When
    byTestId('popover-sheet-close').click();
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(popover.hasAttribute('aria-modal')).toBe(false);
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false);
  });

  it('As a phone user, the Settings sheet going away while open unlocks the page', async () => {
    // Given
    stubViewport(true);
    await renderPopover();
    await openPopover();
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(true);

    // When
    for (const cleanup of cleanups) {
      cleanup();
    }
    cleanups = [];
    await settle();

    // Then
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false);
  });

  it('As a desktop user, the settings popover is not modal: no aria-modal and no scroll lock, though Tab loops inside', async () => {
    // Given
    stubViewport(false);
    document.body.style.overflow = '';
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(byId('mode-popover').hasAttribute('aria-modal')).toBe(false);
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false);
    const controls = tabbables();
    nth(controls, controls.length - 1).focus();
    expect(press('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls[0]);
  });

  it('As a user who resized the window, the settings open as a sheet or a popover by the width at each opening', async () => {
    // Given: opened wide, then closed.
    const viewport = stubViewport(false);
    await renderPopover();
    await openPopover();
    expect(byId('mode-popover').hasAttribute('aria-modal')).toBe(false);
    press('Escape');
    await settle();

    // When: narrowed, then opened again.
    viewport.narrow = true;
    await openPopover();

    // Then
    expect(byId('mode-popover').getAttribute('aria-modal')).toBe('true');
    const controls = tabbables();
    nth(controls, controls.length - 1).focus();
    expect(press('Tab').defaultPrevented).toBe(true);

    // When: widened while open, then closed and opened.
    viewport.narrow = false;
    press('Escape');
    await settle();
    await openPopover();

    // Then
    expect(byId('mode-popover').hasAttribute('aria-modal')).toBe(false);
  });

  it('As a phone user, the settings sheet leaves its title to the sheet header and Save and apply spans the sheet', async () => {
    // Given
    stubViewport(true);
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
    stubViewport(true);
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
