// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush } from 'solid-js';
import { cleanup } from '@solidjs/testing-library';
import { setBackend } from '@dotli/config';

import { DiagnosticsView } from '../../src/components/truapi-debug/Diagnostics.js';
import { buildBaseDiagnosticsRows, buildLightClientVersionLabel, packageVersions } from '../../src/settings-actions.js';
import type * as SettingsActionsModule from '../../src/settings-actions.js';
import { renderComponent, resetStores } from '../helpers/solid.js';
import { nth } from '../helpers/nth.js';
import { byTestId, must, query } from '../support.js';

const actions = vi.hoisted(() => ({
  extraRows: [] as [label: string, value: string][],
}));
vi.mock('../../src/settings-actions.js', async importOriginal => {
  const actual = await importOriginal<typeof SettingsActionsModule>();
  return {
    ...actual,
    // Lets a test add a row the default backend does not produce, such as a node reading "n/a".
    buildBaseDiagnosticsRows: () => [...actual.buildBaseDiagnosticsRows(), ...actions.extraRows],
  };
});

// No chain answers here: the share report's block heights read "n/a".
vi.mock('../../../protocol/src/client.js', () => ({
  isRemoteChainSupported: () => false,
}));

const rpc = vi.hoisted(() => ({ live: null as string | null }));
vi.mock('../../../resolver/src/rpc-resolve.js', () => ({
  getConnectedAssetHubRpcEndpoint: () => rpc.live,
}));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  actions.extraRows = [];
  rpc.live = null;
});

afterEach(() => {
  cleanup();
  resetStores();
  Reflect.deleteProperty(navigator, 'clipboard');
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** Let the lazy imports and promise chains a click starts finish. */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    flush();
  }
}

/** Render the tab, open unless told otherwise. */
function renderView(active = true): void {
  renderComponent(() => <DiagnosticsView active={active} />);
  flush();
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(byTestId('td-diagnostics').querySelectorAll<HTMLButtonElement>('button')).find(
    b => b.textContent === text,
  );
  if (found === undefined) {
    throw new Error(`no "${text}" button`);
  }
  return found;
}

function infoRow(label: string): HTMLElement {
  const found = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="td-diag-row"]')).find(
    row => row.firstElementChild?.textContent === label,
  );
  if (found === undefined) {
    throw new Error(`no "${label}" row`);
  }
  return found;
}

/** A diagnostics row: its label and value, a copy button holding the value on the copyable ones. */
function expectRow(row: Element | undefined, label: string, value: string, copyable = false): void {
  const el = must(row, 'a row');
  expect(el.getAttribute('data-testid')).toBe('td-diag-row');
  expect(query(el, 'dt').textContent).toBe(label);
  expect(query(el, 'dd code').textContent).toBe(value);
  const copy = el.querySelector('button');
  expect(copy?.getAttribute('aria-label') ?? null).toBe(copyable ? `Copy ${label}` : null);
  expect(copy?.getAttribute('title') ?? null).toBe(copyable ? `Click to copy ${label}` : null);
}

/** The rows under a group heading, by its text. */
function groupRows(title: string): Element[] {
  const heading = Array.from(byTestId('td-diagnostics').querySelectorAll('h3')).find(h => h.textContent === title);
  return Array.from(must(heading?.nextElementSibling, `the ${title} list`).children);
}

/** The tab: the share button, the page rows and the package versions by group. */
function expectDiagnostics(): void {
  const share = button('Share diagnostic');
  expect(share.type).toBe('button');
  expect(share.title).toBe('Open a new issue on paritytech/dotli pre-filled with these diagnostics');

  const copyable = new Set(['Site', 'Relay node', 'AssetHub node', 'Bulletin Node']);
  const base = buildBaseDiagnosticsRows();
  const rows = Array.from(byTestId('td-diagnostics-rows').children);
  expect(rows).toHaveLength(base.length);
  base.forEach(([label, value], i) => {
    expectRow(rows[i], label, value, copyable.has(label));
  });

  const lightClient = groupRows('Light client');
  expect(lightClient).toHaveLength(1);
  expectRow(lightClient[0], '@parity/truapi-provider', buildLightClientVersionLabel());
  const { polkadotApi, parityTruapi } = packageVersions();
  const groups: [string, { name: string; version: string }[]][] = [
    ['@polkadot-api', polkadotApi],
    ['@parity/truapi', parityTruapi],
  ];
  const headings = Array.from(byTestId('td-packages').querySelectorAll('h3')).map(h => h.textContent);
  expect(headings).toEqual(['Light client', ...groups.filter(([, pkgs]) => pkgs.length > 0).map(([title]) => title)]);
  for (const [title, pkgs] of groups) {
    if (pkgs.length === 0) {
      continue;
    }
    const listed = groupRows(title);
    expect(listed).toHaveLength(pkgs.length);
    pkgs.forEach((pkg, i) => {
      expectRow(listed[i], pkg.name, pkg.version);
    });
  }
}

describe('The debug panel Diagnostics tab', () => {
  it('As a dotli developer, the tab shows the share button, the page rows and the light client version', () => {
    // When
    renderView();

    // Then
    expectDiagnostics();
  });

  it('As a dotli developer on trusted providers with package versions, the tab lists the nodes and every package', () => {
    // Given
    setBackend('rpc-gateway');
    vi.stubGlobal('__POLKADOT_API_VERSION__', '1.2.3');
    vi.stubGlobal('__POLKADOT_API_VERSIONS__', [{ name: '@polkadot-api/ws-provider', version: '0.4.0' }]);
    vi.stubGlobal('__PARITY_TRUAPI_VERSIONS__', [{ name: '@parity/truapi-host', version: '0.9.0' }]);

    // When
    renderView();

    // Then
    expectDiagnostics();
  });

  it('As a dotli developer, a closed tab renders no diagnostics', () => {
    // When
    renderView(false);

    // Then
    expect(byTestId('td-diagnostics').hidden).toBe(true);
    expect(document.querySelector('[data-testid="td-diagnostics-rows"]')).toBeNull();
  });

  it('As a dotli developer, clicking a copyable diagnostics row copies it and flashes Copied for a second', async () => {
    // Given
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderView();
    vi.useFakeTimers();
    const site = infoRow('Site');

    // When
    query(site, 'button').click();
    await Promise.resolve();
    await Promise.resolve();
    flush();

    // Then
    expect(writeText).toHaveBeenCalledWith(window.location.host);
    expect(query(site, 'code').textContent).toBe('Copied');

    // When
    vi.advanceTimersByTime(1000);
    flush();

    // Then
    expect(query(site, 'code').textContent).toBe(window.location.host);
    expect(infoRow('Build').querySelector('button')).toBeNull();
  });

  it('As a dotli developer, clicking a copyable row that reads n/a copies nothing', async () => {
    // Given
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    actions.extraRows = [['Relay node', 'n/a']];
    renderView();
    const row = infoRow('Relay node');
    const copy = query(row, 'button', HTMLButtonElement);
    expect(query(row, 'code').textContent).toBe('n/a');

    // When
    copy.click();
    await Promise.resolve();

    // Then
    expect(writeText).not.toHaveBeenCalled();
  });

  it('As a dotli developer on trusted providers, the AssetHub row shows the node the client is connected to, in the tab and the shared report', async () => {
    // Given
    setBackend('rpc-gateway');
    rpc.live = 'wss://live.example';
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);

    // When
    renderView();
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

  it('As a dotli developer, Share diagnostic opens a GitHub issue prefilled with the diagnostics', async () => {
    // Given
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderView();

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
        'Transport: Light client per tab',
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
});
