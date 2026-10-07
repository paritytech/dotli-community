// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { flush } from 'solid-js';
import { setBackend, setNetwork } from '@dotli/config';
import type { BlockBar, ChainStatus, TransferState } from '../../../src/network-monitor.js';
import { ChainsPopover } from '../../../src/components/shell/ChainsPopover.js';
import { mountRoot } from '../../../src/mount/root.js';
import { startNetworkStore } from '../../../src/state/network.js';
import { initNetworkHealth } from '../../../src/state/network-health.js';
import { initSettingsStore } from '../../../src/state/settings.js';
import { setProductLoaded } from '../../../src/state/product.js';
import { recordChainsButtonVisible } from '../../../src/state/topbar.js';
import { EXIT_MS } from '../../../src/components/floating/FloatingLayer.js';
import { popoverBody, renderComponent, resetStores, waitForContent } from '../../helpers/solid.js';
import { HISTORY_SLOTS } from '../../../src/components/shell/chains-format.js';
import type * as ChainsFormatModule from '../../../src/components/shell/chains-format.js';
import { byId, byTestId, must, query } from '../../support.js';
import { nth } from '../../helpers/nth.js';
import { stubPhoneViewport } from '../../helpers/viewport.js';
import { useFloatingSurfaces } from '../../helpers/floating.js';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../../../metrics/src/sentry.js', () => sentry);

const format = vi.hoisted(() => ({ describeLiveNetwork: vi.fn() }));
vi.mock('../../../src/components/shell/chains-format.js', async importOriginal => {
  const actual = await importOriginal<typeof ChainsFormatModule>();
  format.describeLiveNetwork.mockImplementation(actual.describeLiveNetwork);
  return { ...actual, describeLiveNetwork: format.describeLiveNetwork };
});

const monitor = vi.hoisted(() => {
  const transfer: TransferState = {
    bytesPerSecond: null,
    fetched: null,
    total: null,
  };
  return {
    listeners: new Set<() => void>(),
    status: [] as unknown[],
    transfer,
    startNetworkWatch: () => undefined,
    stopNetworkWatch: () => undefined,
  };
});

vi.mock('../../../src/network-monitor.js', () => ({
  subscribeNetwork: (l: () => void) => {
    monitor.listeners.add(l);
    return () => monitor.listeners.delete(l);
  },
  getNetworkStatus: () => monitor.status,
  getChainClocks: () => monitor.status,
  getTransfer: () => monitor.transfer,
  startNetworkWatch: () => {
    monitor.startNetworkWatch();
  },
  stopNetworkWatch: () => {
    monitor.stopNetworkWatch();
  },
  holdNetworkWatch: () => {
    monitor.startNetworkWatch();
    return () => {
      monitor.stopNetworkWatch();
    };
  },
}));

const NO_TRANSFER: TransferState = {
  bytesPerSecond: null,
  fetched: null,
  total: null,
};

const SEARCHING = 'Finding peers. This takes a few seconds.';
const TIP = 'For steadier peers, close tabs and apps you are not using and stay close to your router.';

function chain(overrides: Partial<ChainStatus> = {}): ChainStatus {
  return {
    role: 'relay',
    label: 'Relay chain',
    bars: [],
    latest: null,
    sinceLast: null,
    blockTimeMs: 6000,
    reachable: true,
    phase: null,
    peers: null,
    ...overrides,
  };
}

function bars(from: number, count: number, gapMs = 6000): BlockBar[] {
  return Array.from({ length: count }, (_, i) => ({
    number: from + i,
    health: gapMs > 18_000 ? 'veryLate' : gapMs > 9000 ? 'late' : 'onTime',
    gapMs,
  }));
}

function notify(): void {
  for (const listener of [...monitor.listeners]) {
    listener();
  }
}

let stopStore: () => void = () => undefined;
let cleanups: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  // The popover's idle preload is not one of the countdown's timers.
  vi.stubGlobal('requestIdleCallback', () => 1);
  vi.stubGlobal('cancelIdleCallback', () => undefined);
  monitor.status = [];
  monitor.transfer = NO_TRANSFER;
  monitor.startNetworkWatch = vi.fn();
  monitor.stopNetworkWatch = vi.fn();
  sentry.captureException.mockClear();
  stopStore = startNetworkStore();
});

afterEach(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups = [];
  stopStore();
  monitor.listeners.clear();
  resetStores();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function settle(): Promise<void> {
  flush();
  await Promise.resolve();
  flush();
}

function isOpen(): boolean {
  return byId('chains-popover').hasAttribute('data-open');
}

function press(key: string): void {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
}

async function renderPopover(): Promise<void> {
  const { unmount } = renderComponent(() => (
    <div>
      <ChainsPopover />
      <button id="outside" type="button">
        Outside
      </button>
    </div>
  ));
  cleanups.push(unmount);
  await settle();
}

async function openPopover(): Promise<void> {
  // The content's idle preload is a timer of its own, not the countdown's.
  vi.advanceTimersByTime(PRELOAD_IDLE_MS);
  byId('chains-button').click();
  await settle();
  expect(isOpen()).toBe(true);
  await waitForContent('chains-popover');
}

async function closePopover(): Promise<void> {
  press('Escape');
  await settle();
  vi.advanceTimersByTime(EXIT_MS);
  await settle();
}

function body(): HTMLElement {
  return must(popoverBody('chains-popover'), '#chains-popover');
}

function content(): HTMLElement {
  return query(body(), ':scope > [data-testid="chains-content"]');
}

interface ExpectedChain {
  label: string;
  peers?: { text: string; aria: string };
  cell:
    | { kind: 'unavailable' }
    | { kind: 'waiting'; text: string; ghost: 'searching' | 'counting' | 'due'; ghostHeight?: string }
    | { kind: 'bars'; titles: string[]; health: string[]; firstBlock: number };
}

interface ExpectedBody {
  title: string;
  detail: string;
  tone: 'idle' | 'warn' | 'ok' | 'err';
  chains: ExpectedChain[];
  speed?: [string, string];
  size?: [string, string];
}

const texts = (el: Element): (string | null)[] => Array.from(el.children).map(child => child.textContent);

/** The button apart from styling. Whether it shows at all is left to the visibility test. */
function expectChainsButton(open: boolean): void {
  const button = byId('chains-button');
  expect(button.getAttribute('title')).toBe('Network');
  expect(button.getAttribute('aria-label')).toBe('Network');
  expect(button.getAttribute('aria-haspopup')).toBe('dialog');
  expect(button.getAttribute('aria-expanded')).toBe(String(open));
  expect(button.getAttribute('aria-controls')).toBe('chains-popover');
  expect(Array.from(button.children).map(child => child.tagName)).toEqual(['svg']);
}

/** The body in order: head, status well, a group per chain, transfer rows, tips. */
function expectBody(expected: ExpectedBody): void {
  const sections = Array.from(content().children);
  expect(sections).toHaveLength(2 + expected.chains.length + 2);
  expect(sections[0]?.textContent).toBe('Network');
  const status = nth(sections, 1);
  expect(status.getAttribute('data-testid')).toBe('chains-status');
  expect(status.childElementCount).toBe(2);
  expect(status.children[0]?.getAttribute('data-tone')).toBe(expected.tone);
  expect(texts(nth(status.children, 1))).toEqual([expected.title, expected.detail]);

  expected.chains.forEach((chainExpected, i) => {
    const group = nth(sections, 2 + i);
    const [name, cell] = Array.from(group.children) as [Element, Element];
    expect(group.childElementCount).toBe(2);
    expect(name.children[0]?.textContent).toBe(chainExpected.label);
    const peers = nth(name.children, 1);
    expect(peers.textContent).toBe(chainExpected.peers?.text ?? '');
    expect(peers.getAttribute('aria-label')).toBe(chainExpected.peers?.aria ?? null);
    expect(cell.hasAttribute('data-unavailable')).toBe(chainExpected.cell.kind === 'unavailable');
    if (chainExpected.cell.kind === 'unavailable') {
      expect(cell.textContent).toBe('no endpoint on this network');
      expect(cell.childElementCount).toBe(0);
    } else if (chainExpected.cell.kind === 'waiting') {
      expect(cell.childElementCount).toBe(1);
      const strip = nth(cell.children, 0);
      expect(strip.querySelectorAll('[data-testid="chains-bar-stub"]')).toHaveLength(HISTORY_SLOTS - 1);
      expect(strip.childElementCount).toBe(HISTORY_SLOTS + 1);
      const ghost = strip.children[HISTORY_SLOTS - 1] as HTMLElement;
      expect(ghost.textContent).toBe('');
      expect(ghost.dataset['pending']).toBe(chainExpected.cell.ghost);
      expect(ghost.style.height).toBe(chainExpected.cell.ghostHeight ?? '');
      expect(strip.children[HISTORY_SLOTS]?.textContent).toBe(chainExpected.cell.text);
    } else {
      expect(cell.childElementCount).toBe(1);
      const slots = Array.from(nth(cell.children, 0).children) as HTMLElement[];
      const { titles, health, firstBlock } = chainExpected.cell;
      expect(slots).toHaveLength(HISTORY_SLOTS);
      const marks = slots.filter(slot => slot.hasAttribute('data-block'));
      expect(
        slots.slice(0, HISTORY_SLOTS - marks.length).every(slot => slot.dataset['testid'] === 'chains-bar-stub'),
      ).toBe(true);
      expect(marks.map(mark => mark.dataset['block'])).toEqual(titles.map((_, n) => String(firstBlock + n)));
      expect(marks.map(mark => mark.dataset['health'])).toEqual(health);
      expect(marks.map(mark => mark.title)).toEqual(titles);
      expect(marks.map(mark => mark.getAttribute('aria-label'))).toEqual(
        titles.map((title, n) => `Block ${String(firstBlock + n)}, ${title}`),
      );
    }
  });

  const footer = nth(sections, 2 + expected.chains.length);
  expect(footer.childElementCount).toBe(2);
  expect(footer.children[0]?.tagName).toBe('P');
  expect(footer.children[1]?.tagName).toBe('P');
  const [speedRow, sizeRow] = Array.from(footer.children) as [Element, Element];
  expect(texts(speedRow)).toEqual(expected.speed ?? []);
  expect(texts(sizeRow)).toEqual(expected.size ?? []);

  const tips = nth(sections, 3 + expected.chains.length);
  expect(tips.getAttribute('data-testid')).toBe('chains-tips');
  expect(tips.textContent).toBe(TIP);
}

function waitingText(): string | null | undefined {
  return byTestId('chains-bars-waiting').textContent;
}

/** The wait of preloadWhenIdle's timer in an environment without idle callbacks. */
const PRELOAD_IDLE_MS = 2000;

useFloatingSurfaces();

describe('The network popover island', () => {
  it('As a dotli user, the closed button and popover carry their labels and ARIA', async () => {
    // When
    await renderPopover();

    // Then
    expectChainsButton(false);
    // The shared Popover's surface is in the page only from its first opening or idle preload.
    expect(document.getElementById('chains-popover')).toBeNull();
  });

  it('As a user, the network button carries a badge in the network health tone', async () => {
    // When
    await renderPopover();

    // Then: the health starts at syncing, whose tone is idle
    const button = byId('chains-button');
    expect(button.hasAttribute('data-badge')).toBe(true);
    expect(button.dataset['tone']).toBe('idle');
  });

  const statuses: {
    name: string;
    chains: ChainStatus[];
    transfer?: TransferState;
    productLoaded?: boolean;
    expected: ExpectedBody;
  }[] = [
    {
      name: 'starting, with no chain reachable',
      expected: {
        title: 'Syncing',
        detail: SEARCHING,
        tone: 'idle',
        chains: [
          { label: 'Relay chain', cell: { kind: 'unavailable' } },
          { label: 'Asset Hub', cell: { kind: 'unavailable' } },
        ],
      },
      chains: [chain({ reachable: false }), chain({ role: 'assethub', label: 'Asset Hub', reachable: false })],
    },
    {
      name: 'connecting, before any block or phase',
      expected: {
        title: 'Syncing',
        detail: SEARCHING,
        tone: 'idle',
        chains: [
          { label: 'Relay chain', cell: { kind: 'waiting', text: 'connecting', ghost: 'searching' } },
          { label: 'Asset Hub', cell: { kind: 'waiting', text: 'connecting', ghost: 'searching' } },
        ],
        speed: ['Speed', '512 B/s'],
        size: ['Downloading', '2 kB / 4.0 MB'],
      },
      chains: [chain(), chain({ role: 'assethub', label: 'Asset Hub' })],
      transfer: { bytesPerSecond: 512, fetched: 2048, total: 4_194_304 },
    },
    {
      name: 'connecting, a chain syncing and one without an endpoint',
      expected: {
        title: 'Syncing',
        detail: SEARCHING,
        tone: 'idle',
        chains: [
          {
            label: 'Relay chain',
            peers: { text: '1 peer', aria: 'Relay chain: 1 peer connected' },
            cell: { kind: 'waiting', text: 'syncing', ghost: 'searching' },
          },
          { label: 'People', cell: { kind: 'unavailable' } },
        ],
        speed: ['Speed', '2.4 MB/s'],
        size: ['Size', '2.9 MB'],
      },
      chains: [
        chain({ phase: 'syncing', peers: 1 }),
        chain({ role: 'people', label: 'People', reachable: false, peers: 3 }),
      ],
      transfer: {
        bytesPerSecond: 2_500_000,
        fetched: 3_000_000,
        total: 3_000_000,
      },
    },
    {
      name: 'one of two ready, the other counting down to its next block',
      expected: {
        title: 'Syncing',
        detail: SEARCHING,
        tone: 'idle',
        chains: [
          {
            label: 'Relay chain',
            peers: { text: '4 peers', aria: 'Relay chain: 4 peers connected' },
            cell: { kind: 'waiting', text: 'next block in about 5s', ghost: 'counting', ghostHeight: '40%' },
          },
          {
            label: 'Asset Hub',
            peers: { text: '8 peers', aria: 'Asset Hub: 8 peers connected' },
            cell: {
              kind: 'bars',
              firstBlock: 18,
              titles: ['6.0s, on time', '6.0s, on time', '6.0s, on time'],
              health: ['onTime', 'onTime', 'onTime'],
            },
          },
          { label: 'People', cell: { kind: 'waiting', text: 'connecting', ghost: 'searching' } },
        ],
        speed: ['Speed', '39 kB/s'],
      },
      chains: [
        chain({ latest: 10, sinceLast: 1500, peers: 4 }),
        chain({
          role: 'assethub',
          label: 'Asset Hub',
          latest: 20,
          bars: bars(18, 3),
          sinceLast: 1000,
          peers: 8,
        }),
        chain({ role: 'people', label: 'People' }),
      ],
      transfer: { bytesPerSecond: 40_000, fetched: null, total: null },
    },
    {
      name: 'waiting on overdue chains, one of them due any moment',
      expected: {
        title: 'Connection is unstable',
        detail: 'Relay chain and Asset Hub are short on peers',
        tone: 'warn',
        chains: [
          {
            label: 'Relay chain',
            cell: { kind: 'waiting', text: 'due any moment', ghost: 'due', ghostHeight: '100%' },
          },
          {
            label: 'Asset Hub',
            cell: {
              kind: 'bars',
              firstBlock: 18,
              titles: ['6.0s, on time', '6.0s, on time', '12s, 6.0s late', '30s, 24s late'],
              health: ['onTime', 'onTime', 'late', 'veryLate'],
            },
          },
        ],
      },
      chains: [
        chain({ latest: 10, sinceLast: 19_000 }),
        chain({
          role: 'assethub',
          label: 'Asset Hub',
          latest: 20,
          bars: [...bars(18, 2), ...bars(20, 1, 12_000), ...bars(21, 1, 30_000)],
          sinceLast: 20_000,
        }),
      ],
    },
    {
      name: 'a good connection, after the product loaded',
      expected: {
        title: 'Your connection is good',
        detail: 'Light client is in sync on both chains',
        tone: 'ok',
        chains: [
          {
            label: 'Relay chain',
            peers: { text: '12 peers', aria: 'Relay chain: 12 peers connected' },
            cell: {
              kind: 'bars',
              firstBlock: 8,
              titles: ['6.0s, on time', '6.0s, on time', '6.0s, on time'],
              health: ['onTime', 'onTime', 'onTime'],
            },
          },
          {
            label: 'Asset Hub',
            peers: { text: '1 peer', aria: 'Asset Hub: 1 peer connected' },
            cell: {
              kind: 'bars',
              firstBlock: 18,
              titles: ['4.0s, on time', '4.0s, on time', '4.0s, on time'],
              health: ['onTime', 'onTime', 'onTime'],
            },
          },
        ],
      },
      chains: [
        chain({ latest: 10, bars: bars(8, 3), sinceLast: 500, peers: 12 }),
        chain({
          role: 'assethub',
          label: 'Asset Hub',
          latest: 20,
          bars: bars(18, 3, 4000),
          sinceLast: 200,
          peers: 1,
        }),
      ],
      transfer: { bytesPerSecond: 800, fetched: 4096, total: 4096 },
      productLoaded: true,
    },
  ];

  for (const status of statuses) {
    it(`As a dotli user opening it (${status.name}), it shows the status, chains, transfer and tips`, async () => {
      // Given
      monitor.status = status.chains;
      monitor.transfer = status.transfer ?? NO_TRANSFER;
      notify();
      if (status.productLoaded === true) {
        setProductLoaded('app.dot', 'app.dot');
      }
      await renderPopover();

      // When
      await openPopover();

      // Then
      expectChainsButton(true);
      expectBody(status.expected);
    });
  }

  it('As a phone user, the chains open as a sheet whose header names it, so the body has no Network heading', async () => {
    // Given
    stubPhoneViewport(true);
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(must(popoverBody('chains-popover'), 'the sheet body').hasAttribute('data-sheet')).toBe(true);
    expect(byTestId('chains-content').hasAttribute('data-sheet')).toBe(true);
    expect(texts(content())).not.toContain('Network');
  });

  it('As a user on a named network, the menu head carries the network', async () => {
    // Given
    setNetwork('previewnet');
    initSettingsStore();
    cleanups.push(() => {
      localStorage.clear();
    });
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(byTestId('chains-network').textContent).toBe('Previewnet');
    expect(nth(Array.from(content().children), 0).textContent).toBe('NetworkPreviewnet');
  });

  it('As a user who went offline, the menu says so, as the capsule and the badge do', async () => {
    // Given: blocks arrived on time just before the connection dropped
    monitor.status = [chain({ latest: 10, bars: bars(8, 3), sinceLast: 500, peers: 12 })];
    notify();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    cleanups.push(initNetworkHealth());
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(byTestId('chains-status-dot').getAttribute('data-tone')).toBe('err');
    expect(byTestId('chains-status').textContent).toBe('You are offlineNo peers on any chain. Retrying.');
  });

  it('As a user on trusted providers, the caption claims no light client', async () => {
    // Given
    setBackend('rpc-gateway');
    initSettingsStore();
    cleanups.push(() => {
      localStorage.clear();
    });
    monitor.status = [chain({ latest: 10, bars: bars(8, 3), sinceLast: 500 })];
    notify();
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(byTestId('chains-status').textContent).toBe('Your connection is goodServed by trusted providers');
  });

  it('As a user on trusted providers, I get no tip about steadier peers', async () => {
    // Given
    setBackend('rpc-gateway');
    initSettingsStore();
    cleanups.push(() => {
      localStorage.clear();
    });
    monitor.status = [chain({ latest: 10, bars: bars(8, 3), sinceLast: 500 })];
    notify();
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(document.querySelector('[data-testid="chains-tips"]')).toBeNull();
  });

  it('As a user on a chain with no peers, the count says 0 and is marked as none', async () => {
    // Given
    monitor.status = [chain({ latest: 10, sinceLast: 500, peers: 0 })];
    notify();
    await renderPopover();

    // When
    await openPopover();

    // Then
    const peers = byTestId('chains-group-peers');
    expect(peers.textContent).toBe('0 peers');
    expect(peers.hasAttribute('data-none')).toBe(true);
  });

  it('As a dotli user, opening it starts watching the chains and closing it lets the watch lapse', async () => {
    // Given
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(monitor.startNetworkWatch).toHaveBeenCalledTimes(1);
    expect(monitor.stopNetworkWatch).not.toHaveBeenCalled();

    // When
    await closePopover();

    // Then
    expect(isOpen()).toBe(false);
    expect(monitor.stopNetworkWatch).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user watching, bars and peers follow the network store', async () => {
    // Given
    monitor.status = [chain({ latest: 10, sinceLast: 0 })];
    notify();
    await renderPopover();
    await openPopover();
    expect(document.querySelectorAll('[data-block]')).toHaveLength(0);

    // When
    monitor.status = [chain({ latest: 12, bars: bars(11, 2), sinceLast: 0, peers: 2 })];
    notify();
    await settle();

    // Then
    expect([...document.querySelectorAll<HTMLElement>('[data-block]')].map(m => m.dataset['block'])).toEqual([
      '11',
      '12',
    ]);
    expect(byTestId('chains-group-peers').textContent).toBe('2 peers');
    expect(byTestId('chains-status').textContent).toBe('Your connection is goodLight client is in sync');
  });

  it('As a dotli user watching a chain between blocks, the countdown ticks while the popover is open and stops when it closes', async () => {
    // Given
    monitor.status = [chain({ latest: 10, sinceLast: 1000 })];
    notify();
    await renderPopover();
    await openPopover();
    expect(waitingText()).toBe('next block in about 5s');

    // When
    vi.advanceTimersByTime(1000);
    await settle();

    // Then
    expect(waitingText()).toBe('next block in about 4s');
    expect(vi.getTimerCount()).toBe(1);

    // When
    await closePopover();

    // Then
    expect(vi.getTimerCount()).toBe(0);
  });

  it('As a dotli user, the countdown stops when the island unmounts while open', async () => {
    // Given
    monitor.status = [chain({ latest: 10, sinceLast: 1000 })];
    notify();
    await renderPopover();
    await openPopover();
    expect(vi.getTimerCount()).toBe(1);

    // When
    for (const cleanup of cleanups) {
      cleanup();
    }
    cleanups = [];

    // Then
    expect(vi.getTimerCount()).toBe(0);
    expect(monitor.stopNetworkWatch).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, a render error while open is reported, closes the popover and stops the countdown and the watch', async () => {
    // Given: the island in its root, as islands.ts mounts it.
    monitor.status = [chain({ latest: 10, sinceLast: 1000 })];
    notify();
    const container = document.createElement('div');
    document.body.appendChild(container);
    cleanups.push(mountRoot('island:chains-test', container, () => <ChainsPopover />));
    await settle();
    await openPopover();
    expect(vi.getTimerCount()).toBe(1);

    // When: rendering the next network state throws.
    monitor.status = [
      Object.defineProperty(chain({ latest: 11, sinceLast: 0 }), 'label', {
        get: () => {
          throw new Error('the island broke');
        },
      }),
    ];
    notify();
    await settle();

    // Then
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      flow: 'ui',
      step: 'root_render',
      tags: { root: 'popover:chains-popover' },
    });
    vi.advanceTimersByTime(EXIT_MS);
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    expect(monitor.stopNetworkWatch).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(false);

    // When: the next open, once the state renders again.
    monitor.status = [chain({ latest: 11, sinceLast: 0 })];
    notify();
    await openPopover();

    // Then
    expect(isOpen()).toBe(true);
    expect(byTestId('chains-group-label').textContent).toBe('Relay chain');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('As a visitor watching the product download, the transfer footer empties once the product has loaded', async () => {
    // Given
    monitor.transfer = { bytesPerSecond: 2048, fetched: 1024, total: 4096 };
    notify();
    await renderPopover();
    await openPopover();
    const rows = (): string[] =>
      [...document.querySelectorAll('[data-testid="chains-transfer-row"]')].map(row => row.textContent);
    expect(rows()).toEqual(['Speed2 kB/s', 'Downloading1 kB / 4 kB']);

    // When
    setProductLoaded('app.dot', 'app.dot');
    await settle();

    // Then
    expect(rows()).toEqual(['', '']);
  });

  it('As a screen-reader user, the button announces the dialog it opens and whether it is open', async () => {
    // Given
    await renderPopover();
    const button = byId('chains-button');

    // Then
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-controls')).toBe('chains-popover');
    expect(button.getAttribute('aria-expanded')).toBe('false');

    // When
    await openPopover();

    // Then
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const popover = byId('chains-popover');
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-label')).toBe('Network');
    expect(popover.getAttribute('tabindex')).toBe('-1');
  });

  it('As a visitor, the button shows once the product is on screen, whether that came before or after the mount', async () => {
    // Given: revealed before the island mounted.
    recordChainsButtonVisible(true);

    // When
    await renderPopover();

    // Then
    expectChainsButton(false);
    expect(byId('chains-button').closest<HTMLElement>('[data-testid="topbar-item"]')?.hidden).toBe(false);

    // When
    recordChainsButtonVisible(false);
    await settle();

    // Then
    expect(byId('chains-button').closest<HTMLElement>('[data-testid="topbar-item"]')?.hidden).toBe(true);

    // When: revealed after the mount.
    recordChainsButtonVisible(true);
    await settle();

    // Then
    expect(byId('chains-button').closest<HTMLElement>('[data-testid="topbar-item"]')?.hidden).toBe(false);
  });
});

describe('The network popover island, on network updates', () => {
  let stripWidth = 0;

  beforeEach(() => {
    stripWidth = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Strips lay out `stripWidth` wide, with 4px bars and 4px gaps. */
  function spyStripLayout(): {
    rects: MockInstance<HTMLElement['getBoundingClientRect']>;
    styles: MockInstance<typeof window.getComputedStyle>;
  } {
    const rects = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const width = this.dataset['testid'] === 'chains-bars' ? stripWidth : 0;
      return { width, height: 0 } as DOMRect;
    });
    const styles = vi.spyOn(window, 'getComputedStyle');
    return { rects, styles };
  }

  function shownBlocks(): string[] {
    return [...document.querySelectorAll<HTMLElement>('[data-block]')].map(bar => bar.dataset['block'] ?? '');
  }

  it('As a dotli user watching the download, updates that land no block read no layout', async () => {
    // Given
    stripWidth = 76;
    const strip = bars(1, 10);
    monitor.status = [chain({ latest: 10, bars: strip, sinceLast: 0 })];
    notify();
    await renderPopover();
    await openPopover();
    const { rects, styles } = spyStripLayout();

    // When: five speed samples, the same bars each time.
    for (let i = 0; i < 5; i += 1) {
      monitor.transfer = {
        bytesPerSecond: 1000 + i,
        fetched: null,
        total: null,
      };
      monitor.status = [chain({ latest: 10, bars: [...strip], sinceLast: 0 })];
      notify();
      await settle();
    }

    // Then
    expect(rects).toHaveBeenCalledTimes(0);
    expect(styles).toHaveBeenCalledTimes(0);
    expect(shownBlocks()).toHaveLength(10);
  });

  it('As a dotli user, the strip keeps its 48 slots as blocks land, however wide the panel', async () => {
    // Given
    monitor.status = [chain({ latest: 60, bars: bars(1, 60), sinceLast: 0 })];
    notify();
    await renderPopover();

    // When
    await openPopover();

    // Then: the newest 48 of the 60.
    expect(shownBlocks()).toEqual(Array.from({ length: 48 }, (_, i) => String(13 + i)));
  });

  it('As a dotli user watching a chain between blocks, the countdown is computed once per tick', async () => {
    // Given
    let reads = 0;
    const pending = Object.defineProperty(chain({ latest: 10, sinceLast: 1000 }), 'blockTimeMs', {
      get: () => {
        reads += 1;
        return 6000;
      },
    });
    monitor.status = [pending];
    notify();
    await renderPopover();
    await openPopover();
    reads = 0;

    // When
    vi.advanceTimersByTime(250);
    await settle();

    // Then: one computation reads the block time twice.
    expect(reads).toBe(2);
    expect(waitingText()).toBe('next block in about 5s');
  });

  it('As a dotli user, the verdict is worked out once per network update', async () => {
    // Given
    monitor.status = [chain({ latest: 10, bars: bars(1, 10), sinceLast: 0 })];
    notify();
    await renderPopover();
    await openPopover();
    format.describeLiveNetwork.mockClear();

    // When
    monitor.status = [chain({ latest: 11, bars: bars(1, 11), sinceLast: 0 })];
    notify();
    await settle();

    // Then
    expect(format.describeLiveNetwork).toHaveBeenCalledTimes(1);
    expect(byTestId('chains-status').textContent).toBe('Your connection is goodLight client is in sync');
  });

  it('As a dotli user, the countdown ticker stops once no chain is waiting for its first block', async () => {
    // Given
    monitor.status = [chain({ latest: 10, sinceLast: 1000 })];
    notify();
    await renderPopover();
    await openPopover();
    expect(vi.getTimerCount()).toBe(1);

    // When
    monitor.status = [chain({ latest: 11, bars: bars(11, 1), sinceLast: 0 })];
    notify();
    await settle();

    // Then
    expect(vi.getTimerCount()).toBe(0);
    expect(shownBlocks()).toEqual(['11']);
  });

  it('As a dotli user opening it with every chain showing bars, no countdown ticker runs', async () => {
    // Given
    monitor.status = [chain({ latest: 10, bars: bars(1, 10), sinceLast: 0 })];
    notify();
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(vi.getTimerCount()).toBe(0);
  });
});
