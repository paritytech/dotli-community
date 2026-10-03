// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { flush } from 'solid-js';
import type { BlockBar, ChainStatus, TransferState } from '../../../src/network-monitor.js';
import { ChainsPopover } from '../../../src/components/shell/ChainsPopover.js';
import { mountRoot } from '../../../src/mount/root.js';
import { startNetworkStore } from '../../../src/state/network.js';
import { setProductLoaded } from '../../../src/state/product.js';
import { recordChainsButtonVisible, setBlockingModalActive } from '../../../src/state/topbar.js';
import { EXIT_MS } from '../../../src/components/shell/Popover.js';
import {
  pointerPress,
  pointerPressUnfocusable,
  renderComponent,
  resetStores,
  tabTo,
  waitForContent,
} from '../../helpers/solid.js';
import type * as ChainsFormatModule from '../../../src/components/shell/chains-format.js';
import { focusables } from '../../../src/components/focus.js';
import { byId, byTestId, query } from '../../support.js';
import { nth } from '../../helpers/nth.js';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../../../metrics/src/sentry.js', () => sentry);

/** The verdict, counted as the popover computes it. */
const format = vi.hoisted(() => ({ describeLiveNetwork: vi.fn() }));
vi.mock('../../../src/components/shell/chains-format.js', async importOriginal => {
  const actual = await importOriginal<typeof ChainsFormatModule>();
  format.describeLiveNetwork.mockImplementation(actual.describeLiveNetwork);
  return { ...actual, describeLiveNetwork: format.describeLiveNetwork };
});

/** The network monitor, as a test drives it. */
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
  getTransfer: () => monitor.transfer,
  startNetworkWatch: () => {
    monitor.startNetworkWatch();
  },
  stopNetworkWatch: () => {
    monitor.stopNetworkWatch();
  },
}));

const NO_TRANSFER: TransferState = {
  bytesPerSecond: null,
  fetched: null,
  total: null,
};

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

/** The monitor changed: tell whoever listens, as it does. */
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

/** Open the popover, and wait for its body (its own chunk). */
async function openPopover(): Promise<void> {
  byId('chains-button').click();
  await settle();
  expect(isOpen()).toBe(true);
  await waitForContent('chains-popover');
}

/** Close the popover with its button, past the exit transition. */
async function closePopover(): Promise<void> {
  byId('chains-button').click();
  await settle();
  vi.advanceTimersByTime(EXIT_MS);
  await settle();
}

function body(): HTMLElement {
  return query(byId('chains-popover'), ':scope > [data-testid="popover-body"]');
}

/** The open popover's content, inside its body. */
function content(): HTMLElement {
  return query(body(), ':scope > [data-testid="chains-content"]');
}

/** What the open popover's body shows for one chain. */
interface ExpectedChain {
  label: string;
  peers?: { text: string; aria: string };
  cell:
    | { kind: 'unavailable' }
    | { kind: 'waiting'; text: string; ghost: 'searching' | 'counting' | 'due'; ghostHeight?: string }
    | { kind: 'bars'; titles: string[]; health: string[]; firstBlock: number };
}

/** What the open popover's body shows, apart from styling. */
interface ExpectedBody {
  verdict: string;
  /** The verdict's tone, on its dot. */
  tone: 'idle' | 'warn' | 'ok';
  chains: ExpectedChain[];
  speed?: [string, string];
  size?: [string, string];
}

const texts = (el: Element): (string | null)[] => Array.from(el.children).map(child => child.textContent);

/**
 * The button: its ARIA as a popover trigger, its label and its icon. Whether
 * it shows at all (its topbar item's `hidden`) is left to the visibility
 * test.
 */
function expectChainsButton(open: boolean): void {
  const button = byId('chains-button');
  expect(button.getAttribute('title')).toBe('Network');
  expect(button.getAttribute('aria-label')).toBe('Network');
  expect(button.getAttribute('aria-haspopup')).toBe('dialog');
  expect(button.getAttribute('aria-expanded')).toBe(String(open));
  expect(button.getAttribute('aria-controls')).toBe('chains-popover');
  expect(Array.from(button.children).map(child => child.tagName)).toEqual(['svg']);
}

/** The popover body: heading, verdict, a group per chain, the transfer rows and the tips, in order. */
function expectBody(expected: ExpectedBody): void {
  const sections = Array.from(content().children);
  expect(sections).toHaveLength(2 + expected.chains.length + 2);
  expect(sections[0]?.textContent).toBe('Network');
  expect(sections[1]?.childElementCount).toBe(2);
  expect(sections[1]?.children[0]?.getAttribute('data-tone')).toBe(expected.tone);
  expect(sections[1]?.children[1]?.textContent).toBe(expected.verdict);

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
      expect(strip.childElementCount).toBe(2);
      const ghost = strip.children[0] as HTMLElement;
      expect(ghost.textContent).toBe('');
      expect(ghost.dataset['pending']).toBe(chainExpected.cell.ghost);
      expect(ghost.style.height).toBe(chainExpected.cell.ghostHeight ?? '');
      expect(strip.children[1]?.textContent).toBe(chainExpected.cell.text);
    } else {
      expect(cell.childElementCount).toBe(1);
      const marks = Array.from(nth(cell.children, 0).children) as HTMLElement[];
      const { titles, health, firstBlock } = chainExpected.cell;
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
  expect(tips.children[0]?.textContent).toBe('Tips for better performance');
  expect(texts(nth(tips.children, 1))).toEqual(['Close apps and tabs you are not using', 'Move closer to your router']);
}

function waitingText(): string | null | undefined {
  return byTestId('chains-bars-waiting').textContent;
}

describe('The network popover island', () => {
  it('As a dotli user, the closed button and popover carry their labels and ARIA', async () => {
    // When
    await renderPopover();

    // Then
    expectChainsButton(false);
    // The surface is the shared Popover's, and holds nothing until opened.
    const popover = byId('chains-popover');
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-label')).toBe('Network');
    expect(popover.getAttribute('tabindex')).toBe('-1');
    expect(body().childElementCount).toBe(0);
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
        verdict: 'Starting',
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
        verdict: 'Connecting',
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
        verdict: 'Connecting',
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
        verdict: 'Connecting, 2 of 3 ready',
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
        verdict: 'Waiting on Relay chain and Asset Hub',
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
        verdict: 'Your connection is good',
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
    it(`As a dotli user opening it (${status.name}), it shows the verdict, chains, transfer and tips`, async () => {
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
    vi.stubGlobal('matchMedia', (media: string) => ({
      matches: media === '(max-width: 560px)',
      media,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(byId('chains-popover').hasAttribute('data-sheet')).toBe(true);
    expect(byTestId('chains-content').hasAttribute('data-sheet')).toBe(true);
    expect(texts(content())).not.toContain('Network');
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
    expect(byTestId('chains-status').textContent).toBe('Your connection is good');
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
      root: 'popover:chains-popover',
    });
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

  it('As a keyboard user, opening it focuses the popover and Escape closes it, handing focus back to the button', async () => {
    // Given
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(document.activeElement).toBe(byId('chains-popover'));
    expect(byId('chains-button').getAttribute('aria-expanded')).toBe('true');

    // When
    press('Escape');
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(byId('chains-button').getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(byId('chains-button'));
  });

  it('As a screen-reader user, the button announces the dialog it opens and whether it is open', async () => {
    // Given
    await renderPopover();
    const button = byId('chains-button');
    const popover = byId('chains-popover');

    // Then
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-label')).toBe('Network');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-controls')).toBe('chains-popover');
    expect(button.getAttribute('aria-expanded')).toBe('false');

    // When
    await openPopover();

    // Then
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('As a keyboard user, Tab stays inside the popover and it stays open', async () => {
    // Given
    await renderPopover();
    byId('chains-button').focus();
    await openPopover();
    const popover = byId('chains-popover');
    expect(popover.contains(document.activeElement)).toBe(true);
    const controls = focusables(popover);
    controls.at(-1)?.focus();

    // When
    const tab = tabTo(byId('outside'));
    await settle();

    // Then: focus loops back into the popover.
    expect(tab.defaultPrevented).toBe(true);
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(controls[0] ?? popover);
  });

  it('As a dotli user, a press outside closes it without handing focus back to the button', async () => {
    // Given
    await renderPopover();
    byId('chains-button').focus();
    await openPopover();

    // When: the press lands on nothing that takes focus.
    pointerPressUnfocusable(document.body);
    await settle();

    // Then: focus follows the press.
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it('As a dotli user, a click outside closes it, and a click inside does not', async () => {
    // Given
    await renderPopover();
    await openPopover();

    // When
    byTestId('chains-tips').click();
    await settle();

    // Then
    expect(isOpen()).toBe(true);

    // When
    pointerPress(byId('outside'));
    await settle();

    // Then
    expect(isOpen()).toBe(false);
  });

  it('As a dotli user, a blocking modal coming up closes it, stopping the countdown and the network watch', async () => {
    // Given
    monitor.status = [chain({ latest: 10, sinceLast: 1000 })];
    notify();
    await renderPopover();
    await openPopover();
    expect(vi.getTimerCount()).toBe(1);
    expect(monitor.stopNetworkWatch).not.toHaveBeenCalled();

    // When
    setBlockingModalActive(true);
    await settle();
    vi.advanceTimersByTime(EXIT_MS);
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(monitor.stopNetworkWatch).toHaveBeenCalledTimes(1);
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
  /** A stand-in ResizeObserver whose callbacks a test fires. */
  let resizeCallbacks: (() => void)[] = [];
  /** The width the bar strips lay out at. */
  let stripWidth = 0;

  beforeEach(() => {
    resizeCallbacks = [];
    stripWidth = 0;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
        }
        observe(): void {
          resizeCallbacks.push(this.callback);
        }
        unobserve(): void {}
        disconnect(): void {
          resizeCallbacks = resizeCallbacks.filter(cb => cb !== this.callback);
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Strips lay out `stripWidth` wide; 4px bars with 4px gaps. */
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

  it('As a dotli user, the strip shows the bars that fit as it opens, and more once it widens', async () => {
    // Given: 20 bars; the strip fits 10 of them.
    spyStripLayout();
    stripWidth = 76;
    monitor.status = [chain({ latest: 20, bars: bars(1, 20), sinceLast: 0 })];
    notify();
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(shownBlocks()).toEqual(Array.from({ length: 10 }, (_, i) => String(11 + i)));

    // When: the panel widens to fit all 20, with no network update.
    stripWidth = 156;
    for (const callback of resizeCallbacks) {
      callback();
    }
    await settle();

    // Then: the older bars are revealed, not slid in as new blocks.
    expect(shownBlocks()).toHaveLength(20);
    expect(document.querySelectorAll('[data-block][data-new]')).toHaveLength(0);
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
    expect(byTestId('chains-status').textContent).toBe('Your connection is good');
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
